class AppState {
  constructor({ bots = [], api = null, wallets = {}, strategyDefaults = null, env }) {
    this.bots = bots // array
    this.wallets = wallets // { k=>v }
    this.api = api // {}
    this.strategyDefaults = strategyDefaults // {}
    this.env = env // string
  }

  getBot(botId) {
    return this.bots.find(bot => bot.id.toString() === botId.toString())
  }

  findUniqueBotId() {
    if (this.bots.length === 0) return 1
    return Math.max(...this.bots.map(b => Number(b.id))) + 1
  }

  deleteBot(botId) {
    this.bots = this.bots.filter(bot => bot.id.toString() !== botId.toString())
  }
}

module.exports = AppState
