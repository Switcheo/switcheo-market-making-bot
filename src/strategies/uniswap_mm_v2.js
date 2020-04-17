const { BigNumber } = require('bignumber.js')
const BaseStrategy = require('./base_strategy')
const { logger, errorLogger } = require('../logger')

class UniswapMMV2Strategy extends BaseStrategy {
  constructor(config, id) {
    super(config, id)
    this.priceBeforeProfits = { bids: {}, asks: {} }
    this.lastK = null
  }

  getName() {
    return 'uniswap_mm_v2'
  }

  computeCurrentDelta(snapshot) {
    const { pair, requoteRatio } = this.config
    const { assets, orders: _orders } = snapshot
    const [base, quote] = pair.split('_')

    // Get all orders of wallet address
    const orders = _orders[pair]
    const requiredQuotes = this.getRequiredQuotes(snapshot)

    logger().info(`[${pair}] Required / Current Quotes: ${requiredQuotes.length} / ${orders.length}`)
    // logger().info('requiredQuotes', requiredQuotes)

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
        // logger().info('quoting', q.price, qtyDelta, orderQuantity)
        ordersToMake.push({ ...q, quantity: qtyDelta.shiftedBy(-assets[base].decimals) })
        // logger().info('ordersToMake after qty with jitter', ordersToMake)
        return
      }

      // find orders that are same price but too much amount and re-quote
      if (qtyDelta.lt(0) && qtyDelta.negated().div(quoteQuantity).gt(requoteRatio)) {
        // logger().info('requoting', q.price, qtyDelta.negated().div(quoteQuantity), orderQuantity, quoteQuantity)
        ordersToCancel.push(...matchingOrders)
        ordersToMake.push(q)
      }

      // logger().info('leaving', q.price, qtyDelta)
    })

    // cancel any orders that the price do not match the virtual book
    orders.forEach(order => {
      if (requiredQuotes.findIndex(o => o.side === order.side && new BigNumber(o.price).eq(order.price)) < 0) {
        ordersToCancel.push(order)
        // logger().info('cancelling', order.price)
      }
    })
    return [ordersToMake, ordersToCancel, []]
  }

  getRequiredQuotes(snapshot) {
    const requiredQuotes = []

    const { offers, inventory, initialInventory, pairs, assets, orders } = snapshot
    const {
      pair, minTick: _minTick, searchTick: _searchTick,
      margin, maxQuotes, initialTickProfit, subsequentTickProfit, minSize,
    } = this.config

    // limit something
    const previousOrderPrices = orders[pair].length > maxQuotes * 6 ? [] : orders[pair].map(o => o.price.toString())
    const book = offers[pair]
    const [base, quote] = pair.split('_')
    const pricePrecision = pairs[pair].precision
    const priceDecimals = assets[quote].decimals - assets[base].decimals
    const qtyPrecision = assets[base].precision
    const qtyDecimals = assets[base].decimals
    const quoteInventory = inventory[quote].plus(initialInventory[quote].times(margin - 1))
    const baseInventory = inventory[base].plus(initialInventory[base].times(margin - 1))
    const minQty = typeof minSize === 'undefined' ? new BigNumber(0) : new BigNumber(minSize).shiftedBy(assets[quote].decimals)
    const k = quoteInventory.times(baseInventory) // new BigNumber(_k).shiftedBy(assets[quote].decimals + assets[base].decimals)

    if (this.lastK && k.lt(this.lastK)) {
      throw new Error(`K value decreased from ${this.lastK} to ${k.toString()}! Aborting to prevent further asset loss.`)
    }
    this.lastK = k.toString()

    // initialize "previous iteration price" using best bid and asks
    let previousAskPrice, previousBidPrice = null
    for (let i = 0; i < book.bids.length; ++i) { // find lowest bid that is not ours
      if (previousOrderPrices.findIndex(p => book.bids[i].price.eq(p)) < 0) {
        previousAskPrice = book.bids[i].price
        break
      }
    }
    for (let i = book.asks.length - 1; i >= 0; --i) { // find highest ask that is not ours
      if (previousOrderPrices.findIndex(p => book.asks[i].price.eq(p)) < 0) {
        previousBidPrice = book.asks[i].price
        break
      }
    }
    const markPrice = snapshot.trades[pair].length > 0 ?
      snapshot.trades[pair][0].price : // use last price if available..
      initialInventory[quote].dividedBy(initialInventory[base])  // otherwise use initial par value
    if (!previousAskPrice) {
      previousAskPrice = markPrice.dividedBy(1.05) // give a 5% buffer
        .shiftedBy(pricePrecision - priceDecimals)
        .integerValue(BigNumber.ROUND_FLOOR)
        .shiftedBy(priceDecimals - pricePrecision)
    }
    if (!previousBidPrice) {
      previousBidPrice = markPrice.times(1.05) // give a 5% buffer
        .shiftedBy(pricePrecision - priceDecimals)
        .integerValue(BigNumber.ROUND_CEIL)
        .shiftedBy(priceDecimals - pricePrecision)
    }

    // initialize search vars
    const searchTick = parseTick(_searchTick, pricePrecision).shiftedBy(priceDecimals)
    const minTick = parseTick(_minTick, pricePrecision).shiftedBy(priceDecimals)
    const maxPrice = previousAskPrice.plus(minTick)
    const minPrice = previousBidPrice.minus(minTick)

    // initialize quote vars
    let currentPrice = previousAskPrice
    let totalQty = new BigNumber(0)
    let totalProceeds = new BigNumber(0)
    let attempts = 0

    // == QUOTE ASKS ==
    for (let numQuotes = 0; numQuotes < maxQuotes; ++attempts) {

      if (attempts > 100000) {
        logger().warn('Too many attempts. Giving up on searching ask')
        // give up on search!
        this.warnInsufficientInventory(base)
        break
      }

      // increase to next search price, but don't skip previous orders
      const nextTickPrice = BigNumber.maximum(maxPrice, currentPrice.plus(searchTick))

      currentPrice = BigNumber.minimum(nextTickPrice,
        ...previousOrderPrices
          .map(price => this.priceBeforeProfits.asks[price])
          .filter(price => price && currentPrice.lt(price) && nextTickPrice.gt(price))
      )

      const currentPriceWithDecimals = currentPrice

      // price with profits
      const profitMargin = numQuotes === 0 ? initialTickProfit : subsequentTickProfit // in bips
      const finalPrice = currentPrice.times(1 + (profitMargin / 10000))
        .shiftedBy(pricePrecision)
        .shiftedBy(-priceDecimals)
        .integerValue(BigNumber.ROUND_CEIL)
        .shiftedBy(-pricePrecision)
        .shiftedBy(priceDecimals)
      const finalPriceWithDecimals = finalPrice
      
      // derive quantities using original price
      const x = baseInventory.minus(totalQty)
      const y = quoteInventory.plus(totalProceeds)

      const quantity = computeQuantity(x, y, k, currentPriceWithDecimals, false)
        .shiftedBy(-qtyPrecision)
        .integerValue(BigNumber.ROUND_DOWN)
        .shiftedBy(qtyPrecision)
      const proceeds = quantity.times(currentPriceWithDecimals)
      // const profits = quantity.times(finalPriceWithDecimals).integerValue().minus(proceeds)
      
      // ensure quantities are within bounds
      if (quantity.isNaN() ||
          quantity.times(0.995).lte(assets[base].minimumQuantity) ||
          proceeds.times(0.995).lte(assets[quote].minimumQuantity) ||
          quantity.times(0.995).lte(minQty)
      ) {
        // logger().warn('continuing!!! quantity vs assets[base].minimumQuantity', quantity, assets[base].minimumQuantity)
        // logger().warn('continuing!! proceeds vs assets[quote].minimumQuantity', proceeds, assets[quote].minimumQuantity)
        // logger().warn('continuing! quantity vs minQty', quantity, minQty)
        continue
      }

      if (totalQty.plus(quantity).gt(inventory[base])) {
        logger().warn('Total totalQty + quantity > base inventory')
        this.warnInsufficientInventory(base)
        break
      }
      
      // set quote
      const quantityString = quantity.shiftedBy(-qtyDecimals).toString()
      const priceString = finalPriceWithDecimals.toString()

      // logger().info({ currentPrice, finalPrice, quantity, proceeds, profits, baseInventory, quoteInventory })
      // logger().info('quantityString', quantityString)
      // logger().info('priceString', priceString)
      // logger().info('proceeds', proceeds.shiftedBy(-assets[quote].decimals).toString())
      // logger().info('foundAsk', currentPrice, priceString)

      requiredQuotes.push({
        pair: this.config.pair,
        side: 'sell',
        price: priceString,
        quantity: quantityString,
        useNativeTokens: false,
        profitMargin,
      })

      // memoize vars
      this.priceBeforeProfits.asks[finalPrice.toString()] = currentPrice
      previousAskPrice = finalPrice
      previousBidPrice = BigNumber.minimum(previousBidPrice, finalPrice)
      totalQty = totalQty.plus(quantity)
      totalProceeds = totalProceeds.plus(proceeds)
      numQuotes += 1
    }

    // reset quote vars
    currentPrice = previousBidPrice
    totalQty = new BigNumber(0)
    totalProceeds = new BigNumber(0)

    // == QUOTE BIDS ==
    for (let numQuotes = 0; numQuotes < maxQuotes && currentPrice.gt(0);) {
      // decrease to next search price, but don't skip previous orders
      const nextTickPrice = BigNumber.minimum(minPrice, currentPrice.minus(searchTick))
      if (nextTickPrice.lte(0)) {
        // give up on search!
        this.warnInsufficientInventory(quote)
        break
      }
      currentPrice = BigNumber.maximum(nextTickPrice,
        ...previousOrderPrices
          .map(price => this.priceBeforeProfits.bids[price])
          .filter(price => price && currentPrice.gt(price) && nextTickPrice.lt(price))
      )
      const currentPriceWithDecimals = currentPrice

      // price with profits
      const profitMargin = numQuotes === 0 ? initialTickProfit : subsequentTickProfit // in bips
      const finalPrice = currentPrice.dividedBy(1 + (profitMargin / 10000))
        .shiftedBy(-priceDecimals)
        .shiftedBy(pricePrecision)
        .integerValue(BigNumber.ROUND_FLOOR)
        .shiftedBy(-pricePrecision)
        .shiftedBy(priceDecimals)
      const finalPriceWithDecimals = finalPrice

      // derive quantities using original price
      const x = baseInventory.plus(totalQty)
      const y = quoteInventory.minus(totalProceeds)
      const quantity = computeQuantity(x, y, k, currentPriceWithDecimals, true)
        .shiftedBy(-qtyPrecision)
        .integerValue(BigNumber.ROUND_DOWN)
        .shiftedBy(qtyPrecision)
      const proceeds = quantity.times(finalPriceWithDecimals)

    
      // ensure quantities are within bounds
      if (quantity.isNaN() ||
          quantity.times(0.995).lte(assets[base].minimumQuantity) ||
          proceeds.times(0.995).lte(assets[quote].minimumQuantity) ||
          quantity.times(0.995).lte(minQty)
      ) {
        continue
      }
      if (totalProceeds.plus(proceeds).gt(inventory[quote])) {
        logger().warn('Total proceeds + proceeds > quote inventory')
        this.warnInsufficientInventory(quote)
        break
      }
      // set quote
      const quantityString = quantity.shiftedBy(-qtyDecimals).toString()
      const priceString = finalPriceWithDecimals.toString()
      requiredQuotes.push({
        pair: this.config.pair,
        side: 'buy',
        price: priceString,
        quantity: quantityString,
        useNativeTokens: false,
        profitMargin,
      })
      // memoize vars
      this.priceBeforeProfits.bids[finalPrice.toString()] = currentPrice
      previousBidPrice = finalPrice
      totalQty = totalQty.plus(quantity)
      totalProceeds = totalProceeds.plus(proceeds)
      numQuotes += 1
    }

    return requiredQuotes
  }
}

// compute price, p:
//      y * (x + d) - k
// p = ----------------
//       d * (x + d)
function computePrice(x, y, k, d) {
  // logger().info('reversed', x,y,k,d)
  // console.log('x:', x.toString())
  // console.log('y:', y.toString())
  // console.log('k:', k.toString())
  // console.log('d:', d.toString())
  const newX = x.plus(d) // i.e. the new x
  // console.log('newX, x+d:', newX.toString())
  const price = newX.times(y).minus(k).dividedBy(d.times(newX))
  // console.log('price: p', price.toString())
  return price
}


// computer quantity, d:
//       (y-xp) +- sqrt((y-xp)^2 + 4p(xy-k))
// d = --------------------------------------------
//                     2p
function computeQuantity(x, y, k, p, findPositive) {
  // let b = (y-xp)
  const b = y.minus(x.times(p))
  // let c = (xy-k)
  const c = x.times(y).minus(k)
  // let root = sqrt(...)
  const root = b.pow(2).plus(p.times(4).times(c)).squareRoot()
  // d1 and d2 are the two roots of the polynomial
  const d1 = b.plus(root).div(p.times(2))
  const d2 = b.minus(root).div(p.times(2))

  // find smallest real positive root
  if (d1.isFinite()) {
    if (d2.isFinite()) {
      // d1 & d2 are finite
      if (findPositive) {
        if (d1.gt(0) && d2.gt(0)) return BigNumber.minimum(d1, d2)
        if (d1.gt(0)) return d1
        if (d2.gt(0)) return d2
        return new BigNumber('NaN')
      } else {
        if (d1.lt(0) && d2.lt(0)) return BigNumber.maximum(d1, d2).negated()
        if (d1.lt(0)) return d1.negated()
        if (d2.lt(0)) return d2.negated()
        return new BigNumber('NaN')
      }
    }
    // d1 is finite but not d2
    if (findPositive) {
      return d1.gt(0) ? d1 : new BigNumber('NaN')
    } else {
      return d1.lt(0) ? d1.negated() : new BigNumber('NaN')
    }
  }
  // d2 is finite but not d1
  // console.log('price3 reversed:', computePrice(x, y, k, d2))
  if (findPositive) {
    return d2.gt(0) ? d2 : new BigNumber('NaN')
  } else {
    return d2.lt(0) ? d2.negated() : new BigNumber('NaN')
  }
}

function parseTick(specifier, pricePrecision) {
  const [value, suffix] = specifier.split(' ')
  const isMultiplier = suffix === 'x'
  return new BigNumber(value).shiftedBy(isMultiplier ? -pricePrecision : 0)
}
//
// module.exports = {
//   UniswapMMV2Strategy,
//   computeQuantity
// }

module.exports = UniswapMMV2Strategy