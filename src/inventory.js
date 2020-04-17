const Sentry = require('@sentry/node')
const { flatMap, mapValues } = require('lodash')
const { BigNumber } = require('bignumber.js')
const Storage = require('./storage')
const { logger, errorLogger } = require('./logger')

class Inventory {
  static async initialize(id, api, inventory) {
    const i = new Inventory(id, api, inventory)
    await i.loadFromStorage()
    return i
  }

  constructor(id, api, inventory) {
    this.storage = new Storage(`${id}:inventory`)
    this.api = api
    this.initialTokens = parseInventory(inventory, this.api.assets)
  }

  async loadFromStorage() {
    const storedTokens = await this.storage.getHash('tokens')
    if (storedTokens) {
      this.tokens = parseInventory(storedTokens)
    } else {
      this.tokens = this.initialTokens
      await this.storage.setHash('tokens', flatMap(this.tokens, (v, k) => [k, v.toString()]))
    }
  }

  async deleteCachedTokens() {
    logger().info('Deleting cached tokens in redis')
    await this.storage.del('tokens')
  }

  // @dev - for order being made through bot
  async processExecutedOrders(orders) {
    for (const order of orders) {
      if (!order) return // order failed to execute

      const {
        pair, side, offerAmount, wantAmount, fills, makes, profit,
      } = order

      const [offerAsset, wantAsset] = getOfferAndWantAssets(order)

      // TODO: this doesn't work for EOS :(
      if (makes[0]) {
        await this.storage.setHash('openOrders', order.id,
          JSON.stringify({ pair, side, offerAmount, wantAmount, profit, makeFills: [] }))
      }

      // TODO: this doesn't work for EOS :(
      for (const fill of fills) {
        const { fillAmount, wantAmount, feeAssetId, wantAssetId, feeAmount } = fill

        const separateFee = feeAssetId !== wantAssetId
        const acquiredAmount = new BigNumber(wantAmount).minus(separateFee ? 0 : feeAmount)

        const currentWantTokens = this.tokens[wantAsset] || new BigNumber(0)
        const currentOfferTokens = this.tokens[offerAsset] || new BigNumber(0)
        this.tokens[wantAsset] = currentWantTokens.plus(acquiredAmount)
        this.tokens[offerAsset] = currentOfferTokens.minus(fillAmount)

        logger().info('take add:', wantAsset, acquiredAmount.toString())
        logger().info('take deduct:', offerAsset, fillAmount.toString())
        if (separateFee) {
          // TODO: record this to inventory
          logger().info('fee deduct:', feeAssetId, feeAmount.toString())
        }

        await this.storage.setHash('tokens',
          wantAsset, this.tokens[wantAsset].toString(),
          offerAsset, this.tokens[offerAsset].toString(),
        )
      }
    }
  }

  // @dev - for order being filled or cancelled; can be external (change while disconnected)
  async updateInventory(updatedOrders) {
    const openOrders = parseOrders(await this.storage.getHash('openOrders') || {})

    // logger().info(updatedOrders.length, Object.keys(openOrders).length)

    for (const id in openOrders) {
      let updatedOrder = updatedOrders.find(o => o.id === id)
      const existingOrder = openOrders[id]

      if (!updatedOrder) {
        updatedOrder = await this.api.getOrder(id)
        if (!updatedOrder) {
          Sentry.withScope(scope => {
            scope.setTag('inventory', this.id)
            scope.setTag('order', id)
            Sentry.captureMessage('Could not find a previous order!', 'warning')
          })
          logger().warn(`Order ${id} disappeared!`)
          continue
        }
      }

      const newMakeFills = updatedOrder.makeFills || updatedOrder.makes[0].trades
      const newStatus = updatedOrder.orderStatus || updatedOrder.status

      // logger().info('updating status', updatedOrder.id, existingOrder.orderStatus || existingOrder.status, newStatus)
      // logger().info(newMakeFills, existingOrder.makeFills)

      if (newMakeFills.length !== Object.keys(existingOrder.makeFills).length) {
        logger().info('updating inventory for:', id)

        const { side, profit } = existingOrder
        const [offerAsset, wantAsset] = getOfferAndWantAssets(existingOrder)

        for (const fill of newMakeFills) {
          if (existingOrder.makeFills.length && existingOrder.makeFills.find(f => f.id === fill.id)) continue

          const wantAmount = new BigNumber(fill.filledAmount ||
            (side === 'buy' ? fill.amount : new BigNumber(fill.amount).times(fill.price).integerValue(BigNumber.ROUND_DOWN))
          ).dividedBy(1 + ((parseInt(profit || 0, 10)) / 10000)).integerValue(BigNumber.ROUND_UP)
          const offerAmount = fill.wantAmount ||
            (side === 'sell' ? fill.amount : new BigNumber(fill.amount).times(fill.price).integerValue(BigNumber.ROUND_DOWN))

          const currentWantTokens = this.tokens[wantAsset] || new BigNumber(0)
          const currentOfferTokens = this.tokens[offerAsset] || new BigNumber(0)
          this.tokens[wantAsset] = currentWantTokens.plus(wantAmount)
          this.tokens[offerAsset] = currentOfferTokens.minus(offerAmount)

          logger().info('fill add:', wantAsset, wantAmount.toString())
          logger().info('fill deduct:', offerAsset, offerAmount.toString())

          await this.storage.setHash('tokens',
            wantAsset, this.tokens[wantAsset].toString(),
            offerAsset, this.tokens[offerAsset].toString(),
          )
        }

        if (newStatus === 'open') {
          logger().info('updating open order: ', id, { ...existingOrder, makeFills: newMakeFills })
          // update data
          await this.storage.setHash('openOrders', id,
            JSON.stringify({ ...existingOrder, makeFills: newMakeFills }))
        }
      }

      if (newStatus !== 'open') {
        logger().info(`removing ${newStatus} order: `, id)
        await this.storage.delHash('openOrders', id)
      }
    }
  }
}

function parseInventory(inventory, shiftByAssetDecimals = null) {
  return mapValues(inventory, (amount, token) => {
    return new BigNumber(amount).shiftedBy(
      shiftByAssetDecimals ? shiftByAssetDecimals[token].decimals : 0)
  })
}

function parseOrders(orders) {
  return mapValues(orders, JSON.parse)
}

function getOfferAndWantAssets(order) {
  const { pair, side } = order
  const [base, quote] = pair.split('_')
  const offerAsset = side === 'sell' ? base : quote
  const wantAsset = side === 'buy' ? base : quote
  return [offerAsset, wantAsset]
}

module.exports = Inventory
