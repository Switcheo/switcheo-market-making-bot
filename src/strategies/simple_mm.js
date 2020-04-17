const { random } = require('lodash')
const { BigNumber } = require('bignumber.js')
const BaseStrategy = require('./base_strategy')

class SimpleMMStrategy extends BaseStrategy {
  constructor(config, id) {
    super(config, id)
  }

  computeCurrentDelta(snapshot) {
    const { pair } = this.config
    // TODO: generalize this:
    const { midMarketPrice, pairs, assets } = snapshot
    const [base, quote] = pair.split('_')
    const pricePrecision = pairs[pair].precision
    const priceDecimals = assets[quote].decimals - assets[base].decimals
    const requiredQuotes = this.getRequiredQuotes(midMarketPrice, pricePrecision, priceDecimals)

    // TODO: take into account quantities, with minimum-diff quoting
    // (only quote the additional amount if possible, and only adjust if qty > a certain % delta)

    logger().info('Required quotes:', requiredQuotes.length)
    logger().info('Current quotes:', snapshot.orders[pair].length)
    const ordersToMake = requiredQuotes.filter(order => {
      return snapshot.orders[pair].findIndex(
        o => o.side === order.side && new BigNumber(o.price).eq(order.price)) < 0
    })

    // cancel any orders that the price do not match the virtual book
    const ordersToCancel = snapshot.orders[pair].filter(order => {
      return requiredQuotes.findIndex(
        o => o.side === order.side && new BigNumber(o.price).eq(order.price)) < 0
    })
    return [ordersToMake, ordersToCancel, []]
  }

  getRequiredQuotes(midMarketPrice, pricePrecision, priceDecimals) {
    let askPrice = midMarketPrice
    let bidPrice = midMarketPrice
    const minTick = 1 * (10 ** -pricePrecision)
    const inventory = 40000 // TODO: fix me!

    const requiredQuotes = []
    this.config.quotes.forEach((quote) => {
      const [step, stepType] = quote.step.split(' ')

      let count = 0
      while (true) {
        // logger().info('quote', quote)
        count += 1

        // compute quote price reference
        let fromAskPrice = askPrice
        let fromBidPrice = bidPrice
        let stepCount = step
        if (quote.from === 'midmarket') {
          fromAskPrice = midMarketPrice
          fromBidPrice = midMarketPrice
          stepCount *= count
        } else if (quote.from !== 'quote') {
          throw new Error('Unknown from type!')
        }

        // compute price delta
        if (stepType.startsWith('tick')) {
          askPrice = fromAskPrice + minTick * stepCount
          bidPrice = fromBidPrice - minTick * stepCount
        } else if (stepType.startsWith('bip')) {
          askPrice = fromAskPrice + (fromAskPrice * stepCount / 10000) // bips
          bidPrice = fromBidPrice - (fromBidPrice * stepCount / 10000)
        } else {
          throw new Error('Unknown step type!')
        }

        // compute quantities
        const [qty, type] = quote.quantity.split(' ')
        const [quantity, variance] = qty.split('~').map(i => parseInt(i, 10))
        let bidQuantity = quantity
        let askQuantity = quantity

        if (variance) {
          bidQuantity = random(quantity - variance, quantity + variance, false)
          askQuantity = random(quantity - variance, quantity + variance, false)
        }

        if (type === '%') {
          bidQuantity = (inventory * bidQuantity / 100)
          askQuantity = (inventory * askQuantity / 100)
        }

        requiredQuotes.push({
          pair: this.config.pair,
          side: 'sell',
          price: new BigNumber(askPrice).shiftedBy(priceDecimals).toFixed(pricePrecision - priceDecimals),
          quantity: askQuantity,
          useNativeTokens: false,
        })
        requiredQuotes.push({
          pair: this.config.pair,
          side: 'buy',
          price: new BigNumber(Math.max(minTick, bidPrice)).shiftedBy(priceDecimals).toFixed(pricePrecision - priceDecimals),
          quantity: bidQuantity,
          useNativeTokens: false,
        })

        // check conditions to break
        if (quote.repeat === 'until_next_quote') {
          // TODO
          break
        } else {
          if (count > quote.repeat) break
        }
      }

    })
    // logger().info('requiredQuotes', requiredQuotes.length, requiredQuotes)
    return requiredQuotes
  }
}

module.exports = SimpleMMStrategy
