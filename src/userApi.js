const { Bot } = require('./bot')

class UserApi {
  constructor(appState) {
    this.appState = appState
  }

  getStatus() {
    const bots = this.appState.bots
    const totalBots = bots.length
    const totalBotsRunning = bots.filter(bot => bot.status === 'running').length
    const botsStatuses = this.getBotStatuses()
    return { totalBots, totalBotsRunning, botsStatuses }
  }

  // ***********
  // BOTS
  // ***********

  // returns [[111, 'running'], [113, 'stopped'], ...]
  getBotStatuses() {
    return this.appState.bots.map(bot =>
      [bot.id, bot.name, bot.strategy.getName(), bot.strategy.getRequiredPairs().toString(), bot.status])
  }

  async startBot(botId) {
    const bot = this.appState.getBot(botId)
    await bot.start()
  }

  async stopBot(botId) {
    const bot = this.appState.getBot(botId)
    await bot.stop()
  }

  async deleteBot(botId) {
    const bot = this.appState.getBot(botId)
    await bot.stop()
    await bot.deleteStoredData()
    return this.appState.deleteBot(botId)
  }

  async configBot(botId, config) {
    const bot = this.appState.getBot(botId)
    bot.loadStrategy({
      name: bot.strategy.getName(),
      settings: config,
      config: config,
    })
  }

// Example user input:
// {
//   bot: { name: 'asdf', walletId: 1, initialInventory: { JRC: 100, ETH: 1 } },
//   strategy: {
//     name: 'uniswap_mm_v2',
//   },
//   strategySettings: {
//       pair: 'JRC_ETH',
//       minTick: '1 x',
//       searchTick: '1 x',
//       initialTickProfit: 10,
//       subsequentTickProfit: 20,
//       margin: 1,
//       maxQuotes: 5,
//       requoteRatio: 0.1,
//   }
// }
  async createBot(userInput) {
    const { wallets, api, strategyDefaults, env } = this.appState
    const newBotId = this.appState.findUniqueBotId()
    const bot = await Bot.initialize({
      ...userInput.bot,
      id: newBotId,
      api,
      env,
      running: false,
      wallet: wallets[userInput.bot.walletId],
      strategy: {
        ...userInput.strategy,
        settings: {
          ...strategyDefaults[userInput.strategy.name].settings, // defaults
          ...userInput.strategySettings, // overrides
        },
      },
    })

    this.appState.bots.push(bot)
    await bot.saveBot()

    return bot
  }

  // ***********
  // Wallets
  // ***********
  getWallets() {
    return Object.values(this.appState.wallets).map(
      w => ({ id: w.id, blockchain: w.blockchain, address: w.account.address }))
  }

  // ***********
  // Strategies
  // ***********
  getAvailableStrategies() {
    return Object.entries(this.appState.strategyDefaults).map(kv => ({ name: kv[0], description: kv[1].description }))
  }

  getDefaultSettingsForStrategy(strategyName) {
    return this.appState.strategyDefaults[strategyName]
  }
}

module.exports = UserApi
