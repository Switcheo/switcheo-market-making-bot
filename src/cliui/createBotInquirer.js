const ConfigBotInquirer = require('./configBotInquirer')
const { logger, errorLogger } = require('../logger')

class CreateBotInquirer {
  constructor(cliUI) {
    this.cliUI = cliUI
  }

  // Start asking user input.
  // Example of what this function will return after resolved:
  // {
  //     bot: { name: 'asdf', walletId: 1, initialInventory: { JRC: 362, ETH: 1 } },
  //     strategy: {
  //         name: 'uniswap_mm_v2',
  //       },
  //     strategySettings: {
  //       pair: 'JRC_ETH',
  //       minTick: '1 x',
  //       searchTick: '1 x',
  //       initialTickProfit: 10,
  //       subsequentTickProfit: 20,
  //       margin: 1,
  //       maxQuotes: 5,
  //       requoteRatio: 0.1,
  //     },
  //   }
  // }
  async startInquiry() {
    const that = this
    const inputData = { bot: {}, strategy: {}, strategySettings: {} }
    return that.askName(inputData)
      .then((inputs) => that.askWallet(inputs))
      .then((inputs) => that.askInitialInventory(inputs))
      .then((inputs) => that.askStrategy(inputs))
      .then((inputs) => that.startAskConfig(inputs))
      .catch((error) => errorLogger().error(error))
  }

  async askName(inputs) {
    const term = this.cliUI.term
    term.green('\nName your bot: ')
    inputs.bot.name = await term.inputField({ cancelable: true }).promise
    return inputs
  }

  async askWallet(inputs) {
    const term = this.cliUI.term
    const availableWallets = this.cliUI.userApi.getWallets()
    const walletList = availableWallets.map(w => `${w.id} | ${w.blockchain} | ${w.address}`)
    term.green('\nSelect Wallet: ')
    const response = await term.singleColumnMenu(walletList).promise
    inputs.bot.walletId = availableWallets[response.selectedIndex].id
    return inputs
  }

  async askInitialInventory(inputs) {
    const term = this.cliUI.term
    term.green('\nSpecify starting inventory (example: DAI: 201.1, ETH: 1.11 ): ')
    const userInput = `{ ${await term.inputField({ cancelable: true }).promise} }`
    // transform '{ JRC: 1, ETH: 1 }' into '{ "JRC": 1, "ETH": 1 }' so that we can use JSON.parse on it
    const jsonStr = userInput.replace(/(\w+:)|(\w+ :)/g,
      matchedStr => '"' + matchedStr.substring(0, matchedStr.length - 1) + '":')
    inputs.bot.initialInventory = JSON.parse(jsonStr)
    return inputs
  }

  async askStrategy(inputs) {
    const term = this.cliUI.term
    const availableStrategies = this.cliUI.userApi.getAvailableStrategies()
    const strategyList = availableStrategies.map(s => `${s.name} | ${s.description}`)
    term.green('\nSelect Strategy: ')
    const response = await term.singleColumnMenu(strategyList).promise
    inputs.strategy.name = availableStrategies[response.selectedIndex].name
    return inputs
  }

  async startAskConfig(inputs) {
    inputs.strategySettings = await new ConfigBotInquirer(this.cliUI).startInquiry(inputs.strategy.name)
    return inputs
  }
}

module.exports = CreateBotInquirer