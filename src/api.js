const Sentry = require('@sentry/node')
const { api: switcheoAPI, Config } = require('switcheo-js')
const io = require('socket.io-client')
const { BigNumber } = require('bignumber.js')
const { keyBy } = require('lodash')

const { CONTRACT_HASHES, WEBSOCKET_HOSTS } = require('./constants')
const { getBlockchainForType } = require('./utils')
const util = require('util')
const { logger, errorLogger } = require('./logger')

class API {
  constructor(net) {
    this.config = new Config({ net, source: 'switcheo-moonbot' })
    this.contractHashes = CONTRACT_HASHES[net]
    this.websocketHost = WEBSOCKET_HOSTS[net]
    if (!this.websocketHost) throw new Error('Invalid network!')

    this.sockets = {
      orders: {},
      offers: {},
      trades: {},
    }
    this.store = {
      orders: {},
      offers: {},
      trades: {},
    }
  }

  async initialize() {
    this.assets = await switcheoAPI.tokens.get(this.config, { showInactive: true })
    this.pairs = keyBy(await switcheoAPI.pairs.get(this.config, { showDetails: true }), 'name')
  }

  async getOrder(id) {
    return switcheoAPI.orders.show(this.config, id, {})
  }

  async getOrders(account, pair) {
    const waitForOrders = (resolve) => {
      const orders = this.store.orders[account.address]
      if (orders[pair]) {
        resolve(orders[pair])
      } else if (orders !== 'loading') {
        this.store.orders[account.address][pair] = []
        resolve([])
      } else {
        setTimeout(() => waitForOrders(resolve), 100)
      }
    }

    return new Promise(resolve => {
      const room = {
        contractHash: this.contractHashes[account.blockchain],
        address: account.address,
        status: 'open',
      }
      const loadedOrders = []

      if (!this.sockets.orders[account.address]) {
        const socket = io(`wss://${this.websocketHost}/v2/orders`, { transports: ['websocket'] })
        this.sockets.orders[account.address] = socket
        this.store.orders[account.address] = 'loading'

        const loadTillEnd = ({ orders }) => {
          loadedOrders.push(...orders)
          if (orders.length === 50) {
            socket.emit('more', { ...room, beforeId: loadedOrders[loadedOrders.length - 1].id })
          } else {
            this.store.orders[account.address] = loadedOrders.reduce((acc, order) => {
              const pair = `${order.tradeAsset}_${order.baseAsset}`
              if (!acc[pair]) acc[pair] = []
              acc[pair].push(order)
              return acc
            }, {})
          }
        }

        socket.on('all', payload => loadTillEnd(payload))
        socket.on('more', payload => loadTillEnd(payload))
        socket.on('updates', (payload) => {
          const doUpdate = (payload) => {
            const { type, events: orders } = payload
            switch (type) {
              case 'new':
              case 'update': {
                orders.forEach(order => {
                  if (type === 'new' && order.status !== 'open') return
                  const updateOrder = (order) => {
                    const pair = `${order.tradeAsset}_${order.baseAsset}`
                    const ordersForPair = this.store.orders[account.address][pair]
                    if (ordersForPair) {
                      const index = ordersForPair.findIndex(o => o.id === order.id)
                      if (index >= 0) { // order found, update order
                        if (ordersForPair[index].makeFills.length > order.makeFills.length) {
                          // don't update if previous order seem more updated
                          return
                        }
                        this.store.orders[account.address][pair][index] = order
                      } else { // order not found, just add to list
                        this.store.orders[account.address][pair].push(order)
                      }
                    } else if (this.store.orders[account.address] === 'loading') { // orders are still loading, wait for it
                      setTimeout(() => updateOrder(order), 100)
                    } else { // pair has no orders yet, create new list
                      this.store.orders[account.address][pair] = [order]
                    }
                  }
                  updateOrder(order)
                })
                break
              }
              default: throw new Error(`Unhandled WS update type: '${type}'!`)
            }
          }
          if (this.store.orders[account.address] === 'loading') {
            // wait for loading to finish
            setTimeout(() => doUpdate(payload), 100)
          } else {
            doUpdate(payload)
          }
        })
        socket.on('connect', () => {
          loadedOrders.splice(0, loadedOrders.length)
          this.store.orders[account.address] = 'loading'
          socket.emit('join', room)
          socket.emit('all', room)
        })
        socket.on('error', (error) => {
          Sentry.configureScope((scope) => {
            scope.setExtra('error', error)
            Sentry.captureMessage('socket.io error')
          })
        })
        socket.on('disconnect', (reason) => {
          logger().info('got disconnected!')

          if (reason === 'io client disconnect') return

          Sentry.configureScope((scope) => {
            scope.setExtra('reason', reason)
            Sentry.captureMessage('socket.io disconnected')
          })
        })
        socket.on('reconnect', () => {
          logger().info('reconnected to orders!', room)
        })
      }
      waitForOrders(resolve)
    })
  }

  async resetOrders(account) {
    const socket = this.sockets.orders[account.address]
    if (socket) {
      socket.disconnect()
      socket.connect()
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  async getOffers(pair) {
    const waitForOffers = (resolve) => {
      const offers = this.store.offers[pair]
      if (offers) {
        resolve(offers)
      } else {
        setTimeout(() => waitForOffers(resolve), 100)
      }
    }

    return new Promise(resolve => {
      const { type } = this.assets[pair.split('_')[1]]
      const blockchain = getBlockchainForType(type)
      const room = {
        contractHash: this.contractHashes[blockchain],
        pair,
      }

      const parsePayload = (d) => ({ price: new BigNumber(d.price), amount: new BigNumber(d.amount) })

      if (!this.sockets.offers[pair]) {
        const socket = io(`wss://${this.websocketHost}/v2/books`, { transports: ['websocket'] })
        this.sockets.offers[pair] = socket

        socket.on('all', (payload) => {
          this.store.offers[pair] = {
            bids: payload.book.buys.map(parsePayload),
            asks: payload.book.sells.map(parsePayload),
          }
        })
        socket.on('updates', (payload) => {
          const { events: deltas } = payload
          deltas.forEach(delta => {
            const type = delta.type
            const price = new BigNumber(delta.price)
            const quantity = new BigNumber(delta.delta)
            const side = delta.side === 'buy' ? 'bids' : 'asks'
            const index = this.store.offers[pair][side].findIndex(o => o.price.eq(price))

            // If there's an order at the price point, just update the amount,
            // else if it's a cancellation, do nothing,
            // else find the order just below the price point and insert a new order before it.
            if (index > -1) {
              // If there's an order at the price point, just update the amount
              const amount = this.store.offers[pair][side][index].amount.plus(quantity)
              if (amount.isZero()) {
                this.store.offers[pair][side].splice(index, 1)
              } else {
                this.store.offers[pair][side][index].amount = amount
              }
            } else if (type === 'cancel') {
              // do nothing
            } else {
              // find the order just below the price point and insert a new order before it.
              const priceIndex = this.store.offers[pair][side].findIndex(o => o.price.lt(price))
              const offer = { price, amount: quantity }
              if (priceIndex > -1) {
                this.store.offers[pair][side].splice(priceIndex, 0, offer)
              } else {
                this.store.offers[pair][side].push(offer)
              }
            }
          })
        })
        socket.on('connect', () => {
          socket.emit('join', room)
          socket.emit('all', room)
        })
        socket.on('reconnect', () => {
          logger().info('reconnected to offers!', room)
        })
      }
      waitForOffers(resolve)
    })
  }

  async resetOffers(pair) {
    const socket = this.sockets.offers[pair]
    if (socket) {
      socket.disconnect()
      socket.connect()
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  async getTrades(pair) {
    const waitForTrades = (resolve) => {
      const trades = this.store.trades[pair]
      if (trades) {
        resolve(trades)
      } else {
        setTimeout(() => waitForTrades(resolve), 100)
      }
    }

    const parsePayload = (t) => ({ ...t, price: new BigNumber(t.price), amount: new BigNumber(t.amount) })

    return new Promise(resolve => {
      const { type } = this.assets[pair.split('_')[1]]
      const blockchain = getBlockchainForType(type)
      const room = {
        contractHash: this.contractHashes[blockchain],
        pair,
      }

      if (!this.sockets.trades[pair]) {
        const socket = io(`wss://${this.websocketHost}/v2/trades`, { transports: ['websocket'] })
        this.sockets.trades[pair] = socket

        socket.on('all', (payload) => {
          const { trades } = payload
          this.store.trades[pair] = trades.map(t => parsePayload(t))
        })
        socket.on('updates', (payload) => {
          const { events: trades } = payload
          this.store.trades[pair].unshift(...trades.map(t => parsePayload(t)))
        })
        socket.on('connect', () => {
          socket.emit('join', room)
          socket.emit('all', room)
        })
        socket.on('reconnect', () => {
          logger().info('reconnected to trades!', room)
        })
      }
      waitForTrades(resolve)
    })
  }

  async getBalance(account) {
    const rawBalances = await switcheoAPI.balances.get(this.config, [account])
    const assets = this.assets
    const balances = {
      human: {
        available: {},
        locked: {},
        total: {},
      },
      raw: rawBalances,
    }

    for (let asset in rawBalances.locked) {
      const convertedAmount = new BigNumber(rawBalances.locked[asset])
        .shiftedBy(-assets[asset].decimals)
      balances.human.locked[asset] = convertedAmount
    }
    for (let asset in rawBalances.confirmed) {
      const convertedAmount = new BigNumber(rawBalances.confirmed[asset])
        .shiftedBy(-assets[asset].decimals)
      balances.human.available[asset] = convertedAmount
      balances.human.total[asset] = typeof (balances.human.locked[asset]) === 'undefined' ?
        convertedAmount : convertedAmount.plus(balances.human.locked[asset])
    }
    return balances
  }

  async makeOrder(account, pair, side, price, quantity, useNativeTokens) {
    const [base, _quote] = pair.split('_')

    const { assets, config } = this

    const quantityString = new BigNumber(quantity)
      .dp(assets[base].precision)
      .shiftedBy(assets[base].decimals)
      .toFixed(0)

    const params = {
      pair,
      side,
      price,
      quantity: quantityString,
      useNativeTokens,
      orderType: 'limit',
      postOnly: true,
    }

    const order = await switcheoAPI.orders.create(config, account, params)
    if (order.fills.length > 0) {
      throw new Error('Aborting post-only order as there are fills returned!')
    }
    return switcheoAPI.orders.broadcast(config, account, order)
  }

  takeOrder(account, pair, side, quantity, useNativeTokens) {
    const [base, _quote] = pair.split('_')

    const { assets, config } = this

    const quantityString = new BigNumber(quantity)
      .dp(assets[base].precision)
      .shiftedBy(assets[base].decimals)
      .toFixed(0)

    const params = {
      pair,
      side,
      price: null,
      quantity: quantityString,
      useNativeTokens,
      orderType: 'market',
    }
    return switcheoAPI.orders.createAndBroadcast(config, account, params)
  }

  cancelOrder(account, id) {
    return switcheoAPI.cancellations.make(this.config, account, { orderId: id })
  }

  clearClosedOrders() {
    Object.keys(this.store.orders).forEach(address => {
      Object.keys(this.store.orders[address]).forEach(pair => {
        this.store.orders[address][pair] =
          this.store.orders[address][pair].filter(o => o.status === 'open')
      })
    })
  }
}

module.exports = API
