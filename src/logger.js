const log4js = require('log4js')

function logger() {
  return log4js.getLogger('default')
}

function errorLogger() {
  return log4js.getLogger('error')
}

module.exports = {
  logger,
  errorLogger,
}