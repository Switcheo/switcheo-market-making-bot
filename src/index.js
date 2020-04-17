const yaml = require('js-yaml')
const fs = require('fs')
const path = require('path')
const Sentry = require('@sentry/node')

const API = require('./api')
const AppState = require('./appState')
const { Bot, loadBots } = require('./bot')
const Wallet = require('./wallet')
const Reporter = require('./reporter')
const UserApi = require('./UserApi')
const { sleep } = require('./utils')

const dotenv = require('dotenv')
dotenv.config({ path: './../.env' })

require('yargs')
  .usage('Usage: $0 <command> [options]')
  .command('run', 'Run Switcheo Moonbot', {}, run)
  .middleware(argv => {
    if (process.env.ENV) argv.env = process.env.ENV
  }, true)
  .alias('b', 'bot')
  .array('b')
  .describe('b', 'Bot IDs to run')
  .default('b', null, 'Runs all configured bots')
  .alias('c', 'config')
  .describe('c', 'Path to bot configuration file')
  .default('c', null, 'config.<env>.yml')
  .alias('e', 'env')
  .describe('e', 'Environment to run in')
  .choices('e', ['dev', 'test', 'prod', 'local'])
  .default('e', 'dev')
  .alias('r', 'report')
  .boolean('r')
  .describe('r', 'Report errors to Sentry')
  .default('r', false)
  .alias('h', 'help')
  .alias('v', 'version')
  .demandCommand(1, 'You need to run a command to begin!')
  .strict()
  .argv

// Init log4js logger
const log4js = require('log4js')
const appLoggerConfig = {
  appenders: {
    file: {
      type: 'dateFile',
      filename: 'logs/combined.log',
      daysToKeep: 30,
      pattern: '.yyyy-MM-dd'
    },
    error: {
      type: 'console',
    },
  },
  categories: {
    error: { appenders: ['file', 'error'], level: 'trace' },
    default: { appenders: ['file'], level: 'trace' }
  }
}
log4js.configure(appLoggerConfig)

const { logger, errorLogger } = require('./logger')

// Init express app
const express = require('express')
const app = express()
const port = 6969
require('./routes')(app)
app.listen(port, () => logger().info(`App listening on port ${port}!`))

// Init terminal
var terminal = require('terminal-kit').terminal
const CliUI = require('./cliui/cliUI')

// Start application
let running = true

async function run(argv) {
  const { env, config: configPath, report: errorReportingActive } = argv

  console.log('\nStarting bot..')
  initSentry(env, errorReportingActive)

  // load config file
  console.log('\nLoading config..')
  const config = loadConfig(env, configPath)
  const { work_loop_duration, audit_wallet_frequency } = config.settings
  const strategyDefaults = config.strategy_defaults

  // init api
  console.log('\nInitializing API..')
  const api = new API(config.network)
  await api.initialize()

  // load wallets
  console.log('\nLoading Wallets..')
  const wallets = {}
  for (let i = 0; i < config.wallets.length; ++i) {
    const wallet = config.wallets[i]
    wallets[wallet.id] = await new Wallet({ ...wallet, api, network: config.network }).initialize()
  }

  // load bots from files
  console.log('\nLoading bots..')
  const bots = await loadBots(env, { strategyDefaults, wallets: wallets, api })
  const appState = new AppState({ bots, api, wallets, strategyDefaults, env })

  // init reporter
  console.log('\nInitializing reporter..')
  const reporter = new Reporter({ config, api, bots, wallets })

  // init user api for user interactions
  console.log('\nInitializing user API..')
  const userApi = new UserApi(appState)

  // init CLI
  console.log('\nStarting CLI..')
  const cliui = new CliUI(terminal, userApi)
  cliui.start()

  // Loop Bot
  let loops = 0
  while (running) {
    if (loops % audit_wallet_frequency === 0) {
      await sleep(1000)
      const updates = Object.keys(wallets).map(i => wallets[i] && wallets[i].updateBalance())
      await Promise.all(updates)
      reporter.printInventory()
      reporter.doAudit()
      loops = 0
    }

    const botList = appState.bots

    let loopDurationRemaining = work_loop_duration

    for (let i = 0; i < botList.length; ++i, ++loops) {
      const bot = botList[i]
      logger().info(`Looping to ${bot.name}`)

      if (bot.errorCount > config.settings.error_cutoff) {
        logger().warn(`Shutting off ${bot.name} due to too many errors`)
        bot.captureException(new Error(`Maximum errors exceeded. Shutting off bot for ${bot.config.pair}!`))
        appState.bots = botList.splice(i, 1)
        if (botList.length === 0) {
          logger().warn('Shutting down process as there are no active bots left')
          process.exit(0)
        }
        break
      }

      if (!bot.isRunning()) continue
      const workDuration = await bot.doWork()
      loopDurationRemaining -= workDuration

      const sleepDuration = loopDurationRemaining / (bots.length - i)
      await sleep(sleepDuration)
      loopDurationRemaining -= sleepDuration
    }
  }

  process.exit(0)
}

function loadConfig(env, configPath) {
  const defaultPath = path.join(__dirname, '..', `config.${env}.yml`)
  const { settings, strategy_defaults, wallets, bots, network } = yaml.safeLoad(fs.readFileSync(configPath || defaultPath, 'utf8'))
  return { settings, strategy_defaults, wallets, bots, network }
}

function initSentry(env, active) {
  const { SENTRY_DSN: dsn } = process.env
  if (active && !dsn) {
    throw new Error('Sentry reporting is turn on but SENTRY_DSN env var is missing!')
  }
  Sentry.init({
    dsn: active ? dsn : null,
    environment: env,
  })
}

process.on('SIGINT', () => {
  logger().info('\nSIGINT signal received!')
  running = false
})

process.on('SIGTERM', () => {
  logger().warn('\nWARNING: SIGTERM signal received!')
  process.exit(0)
})
