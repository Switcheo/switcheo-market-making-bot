const { BigNumber } = require('bignumber.js')
const { Decimal } = require('decimal.js')
const BaseStrategy = require('./base_strategy')

class SquinkMMStrategy extends BaseStrategy {
  constructor(config, id) {
    super(config, id)
    this.priceBeforeProfits = { bids: {}, asks: {} }
  }

  computeCurrentDelta(snapshot) {
    const { pair, requoteRatio } = this.config
    const { assets, orders: _orders } = snapshot
    const [base, quote] = pair.split('_')

    const orders = _orders[pair]
    const requiredQuotes = this.getRequiredQuotes(snapshot)

    logger().info(`[${pair}] Required / Current Quotes: ${requiredQuotes.length} / ${orders.length}`)

    const ordersToMake = []
    const ordersToCancel = []
    requiredQuotes.forEach(q => {
      const matchingOrders = orders.filter(
        o => o.side === q.side && new BigNumber(o.price).eq(q.price))

      const orderQuantity = matchingOrders.reduce((total, order) => total.plus(order.tradeAmount).minus(order.filledAmount), new BigNumber(0))
      const quoteQuantity = new BigNumber(q.quantity).shiftedBy(assets[base].decimals)
      const qtyDelta = quoteQuantity.minus(orderQuantity)

      // find orders that don't exist, or are same price but too little qty and top up if possible
      const qtyWithJitter = qtyDelta.times(0.99)
      if (qtyWithJitter.gt(assets[base].minimumQuantity) && qtyWithJitter.times(q.price).gt(assets[quote].minimumQuantity)) {
        // logger().info('same price', qtyDelta)
        ordersToMake.push({ ...q, quantity: qtyDelta.shiftedBy(-assets[base].decimals) })
        return
      }

      // find orders that are same price but too much amount and re-quote
      if (qtyDelta.lt(0) && qtyDelta.negated().div(quoteQuantity).gt(requoteRatio)) {
        // logger().info('requoting', qtyDelta.negated(), quoteQuantity, qtyDelta.negated().div(quoteQuantity), requoteRatio)
        ordersToCancel.push(...matchingOrders)
        ordersToMake.push(q)
      }

      // logger().info('leaving it')
    })

    // cancel any orders that the price do not match the virtual book
    orders.forEach(order => {
      if (requiredQuotes.findIndex(o => o.side === order.side && new BigNumber(o.price).eq(order.price)) < 0) {
        ordersToCancel.push(order)
      }
    })
    return [ordersToMake, ordersToCancel, []]
  }

  getRequiredQuotes(snapshot) {
    const requiredQuotes = []

    const { offers, inventory, initialInventory, pairs, assets } = snapshot
    const {
      pair, slippage, maxQuotes, initialTickProfit, subsequentTickProfit,
    } = this.config

    const book = offers[pair]
    const [base, quote] = pair.split('_')
    const pricePrecision = pairs[pair].precision
    const priceDecimals = assets[quote].decimals - assets[base].decimals
    const qtyDecimals = assets[base].decimals
    const quoteInventory = inventory[quote]
    const baseInventory = inventory[base]
    const minTick = new BigNumber(1).shiftedBy(-pricePrecision)

    // initialize "previous iteration price" using best bid and asks
    let previousAskPrice = book.bids.length > 0 ? book.bids[0].price : new BigNumber(0)
    let previousBidPrice = book.asks.length > 0 ?
      book.asks[book.asks.length-1].price :                                   // use lowest ask if possible..
      (
        snapshot.trades[pair].length > 0 ?
          snapshot.trades[pair][0].price.times(2) :                           // otherwise use last price * 2..
          initialInventory[quote].dividedBy(initialInventory[base]).times(2)  // otherwise use initial fair value * 2
      )

    // initialize search vars
    const qtyResolution = 100
    const searchQty = clamp(
      baseInventory.dividedBy(qtyResolution), // target
      assets[base].minimumQuantity,           // lower bound
      assets[base].minimumQuantity * 1000,      // upper bound
    )

    // initialize quote vars
    let currentQty = searchQty
    let totalQty = new BigNumber(0)
    let totalProceeds = new BigNumber(0)
    for (let numQuotes = 0; numQuotes < maxQuotes; currentQty = currentQty.plus(searchQty)) {
      const x = baseInventory.minus(totalQty)
      const y = quoteInventory.plus(totalProceeds)
      const xDec = assets[base].decimals
      const yDec = assets[quote].decimals
      const deltaX = currentQty.negated() // baseDelta
      const deltaYAbs = computeDeltaY(x, y, deltaX, slippage, xDec, yDec) // quoteDelta

      if (deltaYAbs.isNaN()) {
        this.warnInsufficientInventory(base)
        break
      }

      const fairPrice = deltaYAbs.dividedBy(currentQty) // quoteDelta / baseDelta

      // logger().info({ fairPrice })

      const profitMargin = numQuotes === 0 ? initialTickProfit : subsequentTickProfit // in bips
      const markUp = profitMargin / 10000
      const price = fairPrice
        .times(1 + markUp)
        .shiftedBy(pricePrecision - priceDecimals)
        .integerValue(BigNumber.ROUND_CEIL)
        .shiftedBy(priceDecimals - pricePrecision)
      const proceeds = currentQty.times(fairPrice)

      // logger().info({ price, minTick })

      if (price.minus(minTick).lte(previousAskPrice) ||
          proceeds.times(0.995).lte(assets[quote].minimumQuantity)) {
        continue
      }

      totalQty = totalQty.plus(currentQty)
      totalProceeds = totalProceeds.plus(deltaYAbs)
      if (totalQty.gt(inventory[base])) {
        this.warnInsufficientInventory(base)
        break
      }

      const quantityString = currentQty.shiftedBy(-qtyDecimals).toString()
      const priceString = price.toString()

      // logger().info({ baseInventory, quoteInventory, quantityString, priceString })
      // logger().info('proceeds', proceeds.shiftedBy(-assets[quote].decimals).toString())

      requiredQuotes.push({
        pair: this.config.pair,
        side: 'sell',
        price: priceString,
        quantity: quantityString,
        useNativeTokens: false,
        profitMargin,
      })

      previousAskPrice = price
      previousBidPrice = BigNumber.minimum(previousBidPrice, price)
      numQuotes += 1
    }

    // reset search and quote vars
    currentQty = searchQty
    totalQty = new BigNumber(0)
    totalProceeds = new BigNumber(0)
    for (let numQuotes = 0; numQuotes < maxQuotes; currentQty = currentQty.plus(searchQty)) {
      const x = baseInventory.plus(totalQty)
      const y = quoteInventory.minus(totalProceeds)
      const xDec = assets[base].decimals
      const yDec = assets[quote].decimals
      const deltaX = currentQty // baseDelta
      const deltaYAbs = computeDeltaY(x, y, deltaX, slippage, xDec, yDec) // quoteDelta

      if (deltaYAbs.isNaN()) {
        this.warnInsufficientInventory(quote)
        break
      }

      const fairPrice = deltaYAbs.dividedBy(currentQty) // quoteDelta / baseDelta

      // logger().info({ fairPrice })

      const profitMargin = numQuotes === 0 ? initialTickProfit : subsequentTickProfit // in bips
      const markUp = profitMargin / 10000
      const price = fairPrice
        .dividedBy(1 + markUp)
        .shiftedBy(pricePrecision - priceDecimals)
        .integerValue(BigNumber.ROUND_FLOOR)
        .shiftedBy(priceDecimals - pricePrecision)
      const proceeds = currentQty.times(fairPrice)

      // logger().info({ price, minTick, previousBidPrice })

      if (price.plus(minTick).gte(previousBidPrice) ||
          proceeds.times(0.995).lte(assets[quote].minimumQuantity)) {
        continue
      }

      totalQty = totalQty.plus(currentQty)
      totalProceeds = totalProceeds.plus(deltaYAbs)
      if (totalProceeds.gt(inventory[quote])) {
        this.warnInsufficientInventory(quote)
        break
      }

      const quantityString = currentQty.shiftedBy(-qtyDecimals).toString()
      const priceString = price.toString()

      // logger().info({ baseInventory, quoteInventory, quantityString, priceString })
      // logger().info('proceeds', proceeds.shiftedBy(-assets[base].decimals).toString())

      requiredQuotes.push({
        pair: this.config.pair,
        side: 'buy',
        price: priceString,
        quantity: quantityString,
        useNativeTokens: false,
        profitMargin,
      })

      previousBidPrice = price
      numQuotes += 1
    }

    // logger().info({requiredQuotes})

    return requiredQuotes
  }
}

// compute |dY| floored, where:
// dY = (x^p + y^p - (x + dX)^p) ^ (1/p) - y
function computeDeltaY(_x, _y, _dX, p, xDec, yDec) {
  const x = new Decimal(_x.shiftedBy(-xDec).toString())
  const y = new Decimal(_y.shiftedBy(-yDec).toString())
  const dX = new Decimal(_dX.shiftedBy(-xDec).toString())
  // logger().info('x:', x.toString())
  // logger().info('y:', y.toString())
  // logger().info('dX:', dX.toString())

  const dY = x.pow(p).plus(y.pow(p)).minus(x.plus(dX).pow(p)).pow(1 / p).minus(y)
  const dYAbs = new BigNumber(dY.abs().toString()).shiftedBy(yDec).integerValue(BigNumber.ROUND_FLOOR)
  // logger().info('dY: ', dY.toString())
  // logger().info('dYAbs: ', dYAbs.toString())

  return dYAbs
}

function clamp(target, lower, upper) {
  return BigNumber.min(BigNumber.max(target, lower), upper)
}

module.exports = SquinkMMStrategy
