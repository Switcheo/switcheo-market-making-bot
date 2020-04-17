class ConfigBotInquirer {
  constructor(cliUI) {
    this.cliUI = cliUI
  }

  // Start asking user input.
  // Example of what this function will return after resolved:
  //     {
  //       pair: 'JRC_ETH',
  //       minTick: '1 x',
  //       searchTick: '1 x',
  //       initialTickProfit: 10,
  //       subsequentTickProfit: 20,
  //       margin: 1,
  //       maxQuotes: 5,
  //       requoteRatio: 0.1,
  //     }
  async startInquiry(strategyName) {
    switch (strategyName) {
      case 'uniswap_mm_v2':
        return this.startAskUniswapMMV2Config()
      case 'simple_mm':
        return this.startAskSimpleMMConfig()
      default:
        throw new Error(`Strategy ${strategyName} not yet implemented!`)
    }
  }

  async startAskUniswapMMV2Config() {
    const term = this.cliUI.term
    term.green('\nSpecify a pair (e.g. ETH_DAI): ')
    const pair = await term.inputField({ cancelable: true }).promise
    term.green('\nUse Default settings for strategy? [Y|n]:\n')
    const useDefaultSettings = await term.yesOrNo( { yes: [ 'y' , 'ENTER' ] , no: [ 'n' ] }).promise
    const settings = this.cliUI.userApi.getDefaultSettingsForStrategy()
    if (!useDefaultSettings) {
      Object.entries(settings).forEach(async ([key, defaultValue]) => {
        term.green(`\n${key} (e.g. ${defaultValue}): `)
        settings[key] = await term.inputField({ cancelable: true }).promise
      })
    }
    return { ...settings, pair }
  }

  async startAskSimpleMMConfig() {
    throw new Error('NYI')
  }
}

module.exports = ConfigBotInquirer