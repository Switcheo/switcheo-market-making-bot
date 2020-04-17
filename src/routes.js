const Storage = require('./storage')
const { logger, errorLogger } = require('./logger')

module.exports = function(app) {
  app.get('/', async (req, res) => {
    const id = 7777
    const openOrders = await new Storage('7777:inventory').getHash('openOrders')
    logger().info('open orders', openOrders)
    openOrders
    res.send(o)
  })
};
