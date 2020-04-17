const { random } = require('lodash')
const { BigNumber } = require('bignumber.js')
const BaseStrategy = require('./base_strategy')

class KeepAliveMaker extends BaseStrategy {
  constructor(config, id) {
    super(config, id)
    this.side = 'sell' // start with making sell orders, this will flip once we run out of tokens
    this.minInterval = config.minInterval
    this.maxInterval = config.maxInterval
    this.setHeartbeatInterval()
  }

  computeCurrentDelta(snapshot) {
    const { pair, quantity: qtyString } = this.config
    const trades = snapshot.trades[pair]
    const lastTrade = trades.length > 0 ? trades[0] : { timestamp: 0 }

    const now = Date.now() / 1000 | 0
    const ordersToMake = []
    const ordersToCancel = snapshot.orders[pair] // cancels all open unfilled orders

    // logger().info('(now - lastTrade.timestamp), this.heartbeatInterval', (now - lastTrade.timestamp), this.heartbeatInterval)

    // submit a taker trade if last trade happened more than allowed heartbeat interval
    // and there are no open orders
    if (ordersToCancel.length === 0 && (now - lastTrade.timestamp) > this.heartbeatInterval) {
      const { inventory, pairs, assets, offers } = snapshot
      const [base, quote] = pair.split('_')
      const { precision: pricePrecision } = pairs[pair]
      const qtyPrecision = assets[base].precision
      const qtyDecimals = assets[base].decimals

      const [amount, variance] = qtyString.split('~').map(i => parseFloat(i, 10))
      const quantity = new BigNumber(random(amount - variance, amount + variance, true))
        .shiftedBy(qtyPrecision)
        .integerValue(BigNumber.ROUND_DOWN)
        .shiftedBy(qtyDecimals - qtyPrecision)

      // logger().info('quantity, amount, variance', quantity, amount, variance)

      const minTick = new BigNumber(1).shiftedBy(-pricePrecision)
      const bestAsk = (offers[pair].asks[offers[pair].asks.length - 1] || { price: Infinity }).price
      const bestBid = (offers[pair].bids[0] || { price: 0 }).price

      // logger().info('minTick, bestAsk, bestBid', minTick, bestAsk, bestBid)

      const ticksBetween = new BigNumber(bestAsk).minus(bestBid).dividedToIntegerBy(minTick).minus(1)
      if (ticksBetween.lte(0)) {
        logger().warn('Spread is too small to do a safe maker-taker trade')
        return [ordersToMake, ordersToCancel, []]
      }

      const priceDecimals = assets[quote].decimals - assets[base].decimals
      const price = new BigNumber(bestAsk)
        .minus(minTick.times(random(1, ticksBetween.toNumber(), false)))
        .shiftedBy(pricePrecision)
        .integerValue(BigNumber.ROUND_DOWN)
        .shiftedBy(priceDecimals - pricePrecision)

      // logger().info('price', price.toString())

      if (!this.hasSufficientTokens(inventory[base], inventory[quote], quantity, price)) {
        this.side = this.oppositeSide()
      }

      if (!this.hasSufficientTokens(inventory[base], inventory[quote], quantity, price)) {
        throw new Error('Insufficent tokens for both buy and sell')
      }

      ordersToMake.push({
        pair,
        price: price.toString(),
        quantity: quantity.shiftedBy(-qtyDecimals),
        side: this.side,
        useNativeTokens: false,
      })

      // publish instructions
      this.storage.publish(this.config.counterparty,
          JSON.stringify({ quantity: quantity.shiftedBy(-qtyDecimals), side: this.oppositeSide() }))

      // randomize next quote timing
      this.setHeartbeatInterval()
    }

    return [ordersToMake, ordersToCancel, []]
  }

  hasSufficientTokens(baseTokens, quoteTokens, quantity, price) {
    if (this.side === 'sell') {
      return baseTokens.gt(quantity)
    } else if (this.side === 'buy') {
      const proceeds = quantity.times(price).integerValue(BigNumber.ROUND_UP)
      return quoteTokens.gt(proceeds)
    } else {
      throw new Error(`Invalid side: ${this.side}!`)
    }
  }

  setHeartbeatInterval() {
    this.heartbeatInterval = random(this.minInterval, this.maxInterval) // * 60
  }

  oppositeSide() {
    return this.side === 'sell' ? 'buy' : 'sell'
  }
}

module.exports = KeepAliveMaker
