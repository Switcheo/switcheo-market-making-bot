
const Sentry = require('@sentry/node')
const { BigNumber } = require('bignumber.js')
const { cloneDeep } = require('lodash')
const fetch = require('node-fetch')
const { logger, errorLogger } = require('./logger')

class Reporter {
  constructor({ config, api, bots, wallets }) {
    this.api = api
    this.bots = bots
    this.wallets = wallets
    this.lastTGUpdateID = 0
    this.audit = {
      settings: {
        warnMargin: config.settings.inventory_margin_warning,
        maxMargin: config.settings.inventory_margin_max,
      },
      data: {
        trigerredAlerts: {},
        lastRun: {
          inventoryTokens: {},
          walletTokens: {}
        }
      }
    }
    if (process.env.TELEGRAM_TOKEN) {
      this.telegramBaseURL = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`
      this.processTelegramCommands()
    }
  }

  doAudit() {
    const { settings: { warnMargin, maxMargin }, data: { trigerredAlerts, lastRun } } = this.audit
    const { allowancePerWallet, inventoryTokens, walletTokens } = this.getTokenData()

    for (const walletID in allowancePerWallet) {
      logger().info(`\n== WALLET ${walletID} AUDIT ==`)
      Sentry.withScope(scope => {
        scope.setTag('wallet', walletID)
        for (const token in allowancePerWallet[walletID]) {
          const margin = allowancePerWallet[walletID][token].div(walletTokens[token] || 1)
          const balance = walletTokens[token]
          logger().info(`${token}:`, `inv=${allowancePerWallet[walletID][token]}`, `bal=${balance.toString()}`)

          scope.setTag('token', token)
          if (warnMargin > 0 && margin.gt(warnMargin) && !trigerredAlerts[token]) {
            Sentry.captureMessage(`Inventory margin for ${token} is larger than ${warnMargin}x!`, 'warning')
            this.audit.data.trigerredAlerts[token] = 1
          }
          if (maxMargin > 0 && margin.gt(maxMargin) && (!trigerredAlerts[token] || trigerredAlerts[token] < 2)) {
            Sentry.captureMessage(`Inventory margin for ${token} is larger than ${maxMargin}x!`, 'critical')
            this.audit.data.trigerredAlerts[token] = 2
            // errorLogger().error('Shutting down due to exceeding max inventory margin...')
            // shutdown(0)
          }
        }
      })
      logger().info('========================')
    }

    // check inventory vs wallet
    logger().info(`\n== INVENTORY AUDIT ==`)
    // const { inventoryTokens: lastInventoryTokens, walletTokens: lastWalletTokens } = lastRun
    // for (const token in lastInventoryTokens) {
    //   const deltaInventory = inventoryTokens[token].minus(lastInventoryTokens[token])
    //   const deltaWallet = walletTokens[token].minus(lastWalletTokens[token])
    //   if (!deltaInventory.eq(deltaWallet)) {
    //     const msg = `Inventory for ${token} increased by ${deltaInventory.toString()} but wallet balance increased by ${deltaWallet.toString()}`
    //     Sentry.captureMessage(msg, 'warning')
    //     logger().warn(msg)
    //   }
    // }
    logger().info('Done!\n========================')

    // store last snapshot
    this.audit.data.lastRun.inventoryTokens = cloneDeep(inventoryTokens)
    this.audit.data.lastRun.walletTokens = cloneDeep(walletTokens)
  }

  getTokenData() {
    const { bots, wallets } = this
    const allowancePerWallet = {}
    const inventoryTokens = {}
    const walletTokens = {}

    for (const bot of bots) {
      if (!allowancePerWallet[bot.wallet.id]) allowancePerWallet[bot.wallet.id] = {}
      for (const token in bot.inventory.tokens) {
        inventoryTokens[token] = bot.inventory.tokens[token].plus(inventoryTokens[token] || 0)
        allowancePerWallet[bot.wallet.id][token] =
          bot.inventory.tokens[token].plus(allowancePerWallet[bot.wallet.id][token] || 0)
      }
    }

    for (const walletID in allowancePerWallet) {
      for (const token in allowancePerWallet[walletID]) {
        const lockedAmount = typeof(wallets[walletID].balances.raw.locked[token]) === 'undefined' ?
          0 : wallets[walletID].balances.raw.locked[token]
        const total = new BigNumber(wallets[walletID].balances.raw.confirmed[token]).plus(lockedAmount)
        walletTokens[token] = total.plus(walletTokens[token] || 0)
      }
    }

    return { allowancePerWallet, inventoryTokens, walletTokens }
  }

  printInventory() {
    logger().info(this.getInventoryText())
  }

  reportInventory(messageID) {
    this.sendTelegramMessage(this.getInventoryText(), messageID)
  }

  getInventoryText() {
    const { api, bots } = this
    let text = ''
    for (const bot of bots) {
      text += `\n== BOT ${bot.id} [${bot.pair}] INVENTORY ==\n`
      for (const token in bot.inventory.tokens) {
        text += `${token}: ${bot.inventory.tokens[token].shiftedBy(-api.assets[token].decimals)}\n`
      }
      text += '========================\n'
    }
    return text
  }

  async processTelegramCommands() {
    const endpoint = `${this.telegramBaseURL}/getUpdates?offset=${this.lastTGUpdateID + 1}&timeout=30&allowed_updates=messages`
    logger().info('fetching tg update', endpoint)
    const res = await fetch(endpoint).then(res => res.json())
    if (res.ok) {
      const { result: updates } = res
      logger().info(updates)
      if (updates.length) logger().info(`got ${updates.length} updates`)
      for (let i = 0; i < updates.length; ++i) {
        const { update_id: updateID } = updates[i]
        const message = updates[i].message || updates[i].edited_message

        if (!message) continue
        const { chat: { id: chatID }, message_id: messageID, text } = message

        this.lastTGUpdateID = updateID
        logger().info(updateID)
        if (chatID === -1001478508450 && /moonbot/.test(text)) {
          // reply to chat
          if (/test/.test(text)) {
            await this.sendTelegramMessage('test works', messageID)
          }
          if (/report inventory/.test(text)) {
            await this.reportInventory(messageID)
          }
        }
      }
    } else {
      logger().warn({ res })
      Sentry.captureMessage(`Failed to fetch updates from Telegram: ${res.description}`)
    }
    logger().info('done tg process')
    this.processTelegramCommands()
  }

  async sendTelegramMessage(message, messageID = undefined, chatID = -1001478508450) {
    logger().info('sending message')

    const payload = {
      chat_id: chatID,
      text: message,
      reply_to_message_id: messageID
    }

    const res = await fetch(`${this.telegramBaseURL}/sendMessage`, {
      method: 'post',
      body:    JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    }).then(res => res.json()).catch(error => errorLogger().error(error))

    if (!res.ok) {
      logger().warn({ res })
      Sentry.captureMessage(`Failed to post message to Telegram: ${res.description}`)
    }

    return res.result
  }

  reportWallets() {

  }
}

module.exports = Reporter
