const Sentry = require('@sentry/node')
const { BigNumber } = require('bignumber.js')
const { cloneDeep, remove } = require('lodash')
const { FILE_PATHS } = require('./constants')
const yaml = require('js-yaml')
const fs   = require('fs')
const path = require('path')
const { logger, errorLogger } = require('./logger')

const Inventory = require('./inventory')

class Bot {
  static async initialize({ id, name, strategy, api, wallet, initialInventory, env, status = 'stopped' }) {
    logger().info(`Initializing ${name}..`)

    const bot = new Bot({ id, name, api, wallet, status, env })
    await bot.loadInventory(initialInventory, api)
    bot.savedInitialTokens = initialInventory
    bot.loadStrategy(strategy)

    await bot.getSnapshot()

    return bot
  }

  constructor({ id, name, api, wallet, status, env }) {
    console.log('status', status)
    this.id = id
    this.name = name || `bot_${this.id}`
    this.api = api
    this.wallet = wallet
    this.errorCount = 0
    this.resyncOrders = false
    this.resyncOffers = false
    this.status = status
    this.env = env || 'local'
  }

  isRunning() {
    return this.status === 'running'
  }

  async start() {
    this.status = 'running'
    this.saveBot()
  }

  async stop() {
    this.status = 'stopped'
    await this.saveBot()
  }

  getSaveFilePath() {
    return path.join(__dirname, `${FILE_PATHS.botsDirectory}`, this.env, `${String(this.id).padStart(12, '0')}.yml`)
  }

  // Save current bot settings to yml file
  async saveBot() {
    const p = this.getSaveFilePath()
    const data = {
      id: this.id,
      name: this.name,
      wallet: this.wallet.id,
      initialInventory: this.savedInitialTokens,
      status: this.status,
      strategy: {
        name: this.strategy.getName(),
        settings: this.strategy.config
      },
    }

    // create directory if it doesn't already exist
    await fs.promises.mkdir(path.dirname(p), {recursive: true})

    fs.writeFileSync(p, yaml.safeDump(data), (err) => {
      if (err) throw err;
      logger().info('Bot has been saved!')
    })
  }

  async deleteStoredData() {
    await this.deleteSavedFile()
    await this.inventory.deleteCachedTokens()
  }

  async deleteSavedFile() {
    const p = this.getSaveFilePath()
    logger().info('Deleting saved file at ', p)
    return fs.promises.unlink(p)
  }

  async loadInventory(inventory) {
    this.inventory = await Inventory.initialize(this.id, this.api, inventory)
  }

  loadStrategy(strategy) {
    const Strategy = require(`./strategies/${strategy.name}.js`)
    this.strategy = new Strategy(strategy.settings, this.id)
    this.pair = this.strategy.config.pair
  }

  async doResync() {
    const pairs = this.strategy.getRequiredPairs()
    for (const pair of pairs) {
      if (this.resyncOrders) await this.api.resetOrders(this.wallet.account)
      if (this.resyncOffers) await this.api.resetOffers(pair)
    }

    this.resyncOrders = false
    this.resyncOffers = false
  }

  async getSnapshot() {
    await this.doResync()

    const orders = {}
    const offers = {}
    const trades = {}

    const pairs = this.strategy.getRequiredPairs()
    for (const pair of pairs) {
      orders[pair] = cloneDeep(await this.api.getOrders(this.wallet.account, pair))
      offers[pair] = cloneDeep(await this.api.getOffers(pair))
      trades[pair] = cloneDeep(await this.api.getTrades(pair))
    }

    return { pairs, orders, offers, trades }
  }

  async doWork() {
    if (!this.isRunning()) return
    this.processing = true
    const start = process.hrtime()

    try {
      logger().info(`\n\n[${this.pair}] == |${this.name}| starting work  ==`)

      const { pairs, orders, offers, trades } = await this.getSnapshot()

      // console.log('dowork pair', this.pair)
      await this.inventory.updateInventory(orders[this.pair]) // inventory needs all orders

      for (const pair of pairs) {
        remove(orders[pair], o => o.status !== 'open') // snapshot only needs open orders
      }

      const snapshotWithConfig = {
        midMarketPrice: this.strategy.config.initial_price,
        assets: this.api.assets,
        pairs: this.api.pairs,
        inventory: this.inventory.tokens,
        initialInventory: this.inventory.initialTokens,
        orders,
        offers,
        trades,
      }

      // logger().info('snapshot', snapshotWithConfig.midMarketPrice, snapshotWithConfig.initialInventory, orders, offers, trades)

      const [ordersToMake, ordersToCancel, ordersToTake] = this.strategy.computeCurrentDelta(snapshotWithConfig)

      // logger().info('ordersToMake', ordersToMake)
      // const [base, quote] = this.pair.split('_')
      // const [makeBaseTokens, makeQuoteTokens] = getTokenRequirements(ordersToMake)
      // const [takeBaseTokens, takeQuoteTokens] = getTokenRequirements(ordersToTake)

      const mustCancelFirst = true
      // const mustCancelFirst = (
      //   makeBaseTokens.plus(takeBaseTokens).gt(this.wallet.balances.human.available[base]) ||
      //   makeQuoteTokens.plus(takeQuoteTokens).shiftedBy(this.api.assets[base].decimals - this.api.assets[quote].decimals).gt(this.wallet.balances.human.available[quote])
      // )

      if (ordersToCancel.length) logger().info(`[${this.pair}] Cancelling orders:`, ordersToCancel.length)
      const cancels = ordersToCancel.map(order =>
        this.api.cancelOrder(this.wallet.account, order.id)
          .catch(err => {
            if (/filled or cancelled/.test(err.message)) this.resyncOrders = true
            this.errorCount += 1
            this.captureException(err)
            logger().warn('CANCEL FAILED!', this.pair, order.id, err.message)
          })
      )

      // wait for all cancellations to succeed before makes
      if (mustCancelFirst) await Promise.all(cancels)

      if (ordersToMake.length) logger().info(`[${this.pair}] Making orders:`, ordersToMake.length)
      const makes = ordersToMake.map(order =>
        this.api.makeOrder(this.wallet.account, order.pair, order.side, order.price, order.quantity, false)
          .then(o => ({ ...o, profit: order.profitMargin }))
          .catch(err => {
            if (/a better price is now available/.test(err.message)) this.resyncOffers = true
            this.errorCount += 1
            this.captureException(err)
            logger().warn('MAKE FAILED!', this.pair, err.message)
          })
      )
      const executedOrders = await Promise.all(makes)

      if (ordersToTake.length) logger().info(`[${this.pair}] Taking orders:`, ordersToTake.length)
      const takes = ordersToTake.map(order =>
        this.api.takeOrder(this.wallet.account, order.pair, order.side, order.quantity, false)
          .then(o => ({ ...o, profit: order.profitMargin }))
          .catch(err => {
            this.errorCount += 1
            this.captureException(err)
            logger().warn('TAKE FAILED!', this.pair, err.message)
          })
      )
      executedOrders.push(...(await Promise.all(takes))) // mutating concat

      // wait for all cancellations to succeed before processing executions
      if (!mustCancelFirst) await Promise.all(cancels)

      await this.inventory.processExecutedOrders(executedOrders)
    } catch (err) {
      this.errorCount += 1
      this.captureException(err)
      errorLogger().error(err)
    }

    const end = process.hrtime(start)[1] / 1000000
    logger().info(`\n\n[${this.pair}] == |${this.name}| done in ${end}ms ==`)

    this.processing = false
    return end
  }

  captureException(err) {
    Sentry.withScope(scope => {
      scope.setTag('bot', this.id)
      scope.setTag('name', this.name)
      scope.setTag('wallet', this.wallet.id)
      Sentry.captureException(err)
    })
  }
}

function getTokenRequirements(orders) {
  let requiredBaseTokens = new BigNumber(0)
  let requiredQuoteTokens = new BigNumber(0)

  for (order of orders) {
    if (order.side === 'sell') {
      requiredBaseTokens = requiredBaseTokens.plus(order.quantity)
    } else {
      requiredQuoteTokens = requiredQuoteTokens.plus(new BigNumber(order.quantity).times(order.price))
    }
  }

  return [requiredBaseTokens, requiredQuoteTokens]
}


// load bot data from default folder specified in constants.js
// also pass in the list of strategy default settings loaded from config file
async function loadBots(env, config = { strategyDefaults: null, wallets: null, api: null }) {
  const botsDirectory = FILE_PATHS.botsDirectory
  const p = path.join(__dirname, `${botsDirectory}`, env)

  // create directory if it doesn't already exist
  await fs.promises.mkdir(p, {recursive: true})

  const fileNames = await fs.promises.readdir(p)
  const { strategyDefaults, wallets, api } = config

  const bots = await Promise.all(
    fileNames
      .map(fileName => {
        logger().info(`loading bot from file ${fileName}`)
        const botData = yaml.safeLoad(fs.readFileSync(path.join(p, fileName), 'utf8'))
        return Bot.initialize({
          ...botData,
          api,
          env,
          running: false,
          wallet: wallets[String(botData.wallet)],
          strategy: {
            ...botData.strategy,
            settings: {
              ...strategyDefaults[botData.strategy.name].settings, // defaults
              ...botData.strategy.settings, // overrides
            },
          },
        })
      })
  )
  return bots
}

module.exports = {
  Bot,
  loadBots,
}
