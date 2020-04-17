const Sentry = require('@sentry/node')
const Storage = require('../storage')
const { logger, errorLogger } = require('../logger')

class BaseStrategy {
  constructor(config, id) {
    if (this.constructor.name === 'BaseStrategy') {
      throw new Error('You are trying to instantiate an abstract class!')
    }
    logger().info(`Initializing ${this.constructor.name} with config:`, config)
    this.botID = id
    this.config = config
    this.storage = new Storage(`${id}:${this.constructor.name}`)
    this.alertedInsufficientInventory = false
  }

  getName() {
    throw new Error('This method must be implemented by the inherited class!')
  }

  getRequiredPairs() {
    return this.config.requiredPairs || [this.config.pair]
  }

  computeCurrentDelta(_snapshot) {
    throw new Error('This method must be implemented by the inherited class!')
  }
  getRequiredQuotes(_snapshot) {
    throw new Error('This method must be implemented by the inherited class!')
  }

  warnInsufficientInventory(token) {
    if (!this.alertedInsufficientInventory) {
      Sentry.withScope(scope => {
        scope.setTag('bot', this.botID)
        scope.setTag('token', token)
        Sentry.captureMessage(
          `Insufficient inventory of ${token} for ${this.config.pair}!`, 'warning')
      })
      this.alertedInsufficientInventory = true
    }
    logger().warn(`WARNING: inventory of ${token} for ${this.config.pair} depleted!`)
  }
}

module.exports = BaseStrategy
