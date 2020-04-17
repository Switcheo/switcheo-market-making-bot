const BaseStrategy = require('./base_strategy')

class KeepAliveTaker extends BaseStrategy {
  constructor(config, id) {
    super(config, id)
    this.takeOrders = []
    this.storage.receive(order => this.queueTakeOrders(order))
  }

  computeCurrentDelta(snapshot) {
    const { pair } = this.config
    // const [base, quote] = pair.split('_')

    const takeOrders = []
    for (const order of this.takeOrders) {
      const { side, quantity } = order
      // TODO: detect if we are out of inventory
      takeOrders.push({
        pair,
        side,
        quantity,
      })
    }
    this.takeOrders = []

    return [[], [], takeOrders]
  }

  queueTakeOrders(order) {
    logger().info(order)
    this.takeOrders.push(JSON.parse(order))
  }
}

module.exports = KeepAliveTaker
