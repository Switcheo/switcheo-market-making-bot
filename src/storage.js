const redis = require("redis"),
      client = redis.createClient(),
      subscriber = redis.createClient()
const { logger, errorLogger } = require('./logger')
const { promisify } = require('util')

const getAsync = promisify(client.get).bind(client)
const setAsync = promisify(client.set).bind(client)
const delAsync = promisify(client.del).bind(client)
const hsetAsync = promisify(client.hmset).bind(client)
const hgetallAsync = promisify(client.hgetall).bind(client)
const hdelAsync = promisify(client.hdel).bind(client)

class Storage {
  constructor(id) {
    this.prefix = `switcheo-moonbot:${id}`
    subscriber.subscribe(this.channelKey())
  }

  async get(key) {
    return await getAsync(this.prefixKey(key))
  }

  async set(key, value) {
    return await setAsync(this.prefixKey(key), value)
  }

  async del(key) {
    return await delAsync(this.prefixKey(key)).catch(err => {
      errorLogger().error('DEL FAILED! ', key)
    })
  }

  async getHash(key) {
    return await hgetallAsync(this.prefixKey(key))
  }

  async setHash(key, ...args) {
    try {
      return await hsetAsync(this.prefixKey(key), ...args)
    } catch(error) {
      errorLogger().error('err', error)
      errorLogger().error('key', key)
      errorLogger().error('args', args)
      // expected output: ReferenceError: nonExistentFunction is not defined
      // Note - error messages will vary depending on browser
    }
  }

  async delHash(key, field) {
    return await hdelAsync(this.prefixKey(key), field)
  }

  publish(botWithStrategy, message) {
    // logger().info('publish', `switcheo-moonbot:${botWithStrategy}:inbox`, message)
    return client.publish(`switcheo-moonbot:${botWithStrategy}:inbox`, message)
  }

  receive(callback) {
    // logger().info('callback', this.channelKey(this.id))
    subscriber.on('message', (channel, message) => {
      if (channel === this.channelKey(this.id)) {
        logger().info('receive', channel, message)
        callback(message)
      }
    })
  }

  prefixKey(key) {
    return `${this.prefix}:${key}`
  }

  channelKey() {
    return `${this.prefixKey('inbox')}`
  }
}

module.exports = Storage
