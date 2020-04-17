const CliTable = require('cli-table')
const CreateBotInquirer = require('./createBotInquirer')
const ConfigBotInquirer = require('./configBotInquirer')
const { logger, errorLogger } = require('../logger')

class CliUI {
  constructor(term, userApi) {
    this.term = term
    this.userApi = userApi
  }

  start() {
    this.term.red('\nStarted!')
    this.awaitInput()

    this.term.on('key', (name, matches, data) => {
      // logger().info('\'key\' event:', name)
      if (name === 'CTRL_C') { this.terminate() }
    })
  }

  terminate() {
    this.term.grabInput(false)
    setTimeout(function () { process.exit() }, 100)
  }

  awaitInput() {
    const term = this.term
    const that = this
    const userApi = this.userApi
    term.bold('\nSelect a command: ')

    var commands = [
      'help',
      'quit',
      'create bot',
      'delete bot',
      'config bot',
      'start bot',
      'stop bot',
      'restart bot',
      'status',
    ]

    term.inputField(
      {
        autoComplete: commands,
        autoCompleteHint: true,
        autoCompleteMenu: true,
        tokenHook: function (token, isEndOfInput, previousTokens, term, config) {
          var previousText = previousTokens.join(' ')
          switch (token) {
            case 'create' :
              config.style = term.red
              return previousTokens.length ? null : term.bold.red
            case 'bot' :
              return previousText === 'create' || previousText === 'delete' || previousText === 'config' ||
              previousText === 'start' || previousText === 'stop' || previousText === 'restart' ?
                term.brightMagenta : null
            case 'status' :
            case 'help' :
              return term.blue
          }
        }
      },
      async function (error, input) {
        // term.green(`'\nYour command is: ${input}\n`)
        switch (input) {
          case 'create bot' :
            that.initiateCreateBot()
            break
          case 'delete bot' :
            that.initiateDeleteBot()
            break
          case 'start bot' :
            that.initiateStartBot()
            break
          case 'stop bot' :
            that.initiateStopBot()
            break
          case 'config bot' :
            that.initiateConfigBot()
            break
          case 'status' :
            that.showStatus()
            break
          case 'help':
            term.green('\nAvailable commands:\n')
            commands.forEach((command) => term.green(`${command}\n`))
            that.awaitInput()
            break
          case 'quit':
            term.green('\nGoodbye\n')
            that.terminate()
            break
          default:
            term.red('Unrecognised input. Try again or type \'help\': \n')
            that.awaitInput()
        }
      }
    )
  }

  showStatus() {
    const { userApi, term } = this
    const { botsStatuses, totalBotsRunning, totalBots } = userApi.getStatus()
    term.green('\nStatus:')
    term.green(`\n${totalBotsRunning} / ${totalBots} Bots Running`)
    term.green('\n\nBot Statuses:\n')
    const cliTable = new CliTable({
      head: ['ID', 'Name', 'Strategy', 'Pairs', 'Status'],
      colWidths: [10, 20, 20, 20, 20]
    })
    cliTable.push(...botsStatuses)
    term.blue(`${cliTable.toString()}\n`)
    this.awaitInput()
  }

  initiateStartBot() {
    const { userApi, term } = this
    const that = this

    term.green('\nSelect bot to start:\n')
    const botIds = userApi.getBotStatuses().filter(b => b[4] === 'stopped').map(b => b[0])

    if (botIds.length === 0) {
      term.green('\nNo stopped bots to start.\n')
      this.awaitInput()
      return
    }

    term.singleColumnMenu([...botIds, 'cancel'], async function (error, response) {
      const idSelected = response.selectedText
      if (idSelected === 'cancel') {
        term.green(`\nCancelled starting bot\n`)
      } else {
        await userApi.startBot(idSelected)
        term.green(`\nStarted Bot ID: ${idSelected}\n`)
      }
      that.awaitInput()
    })
  }

  initiateStopBot() {
    const { userApi, term } = this
    const that = this

    term.green('\nSelect bot to stop:\n')
    const botIds = userApi.getBotStatuses().filter(b => b[4] === 'running').map(b => b[0])

    if (botIds.length === 0) {
      term.green('\nNo running bots to stop.\n')
      this.awaitInput()
      return
    }

    term.singleColumnMenu([...botIds, 'cancel'], async function (error, response) {
      const idSelected = response.selectedText
      if (idSelected === 'cancel') {
        term.green(`\nCancelled starting bot\n`)
      } else {
        await userApi.stopBot(idSelected)
        term.green(`\nStopped Bot ID: ${idSelected}\n`)
      }
      that.awaitInput()
    })
  }

  initiateDeleteBot() {
    const { userApi, term } = this
    const that = this

    term.green('\nSelect bot to delete:\n')
    const botIds = userApi.getBotStatuses().map(b => b[0])

    if (botIds.length === 0) {
      term.green('\nNo bots to delete.\n')
      this.awaitInput()
      return
    }

    term.singleColumnMenu([...botIds, 'cancel']).promise.then(async (response) => {
      const idSelected = response.selectedText
      if (idSelected === 'cancel') {
        term.green(`\nCancelled deleting bot\n`)
      } else {
        await userApi.deleteBot(idSelected)
        term.green(`\nDeleted Bot ID: ${idSelected}\n`)
      }
      that.awaitInput()
    }).catch(error => errorLogger().error(error))
  }

  initiateCreateBot() {
    const { userApi, term } = this
    const that = this

    const createBotInquirer = new CreateBotInquirer(this)
    createBotInquirer.startInquiry().then(async userResponse => {
      const bot = await userApi.createBot(userResponse)
      term.green(`Bot with ID ${bot.id} created`)
      that.awaitInput()
    }).catch(error => errorLogger().error(error))
  }

  initiateConfigBot() {
    const { userApi, term } = this
    const that = this


    term.green('\nSelect bot to config:\n')
    const botIds = userApi.getBotStatuses().map(b => b[0])

    if (botIds.length === 0) {
      term.green('\nNo bots to config.\n')
      this.awaitInput()
      return
    }

    term.singleColumnMenu([...botIds, 'cancel'], async function (error, response) {
      const idSelected = response.selectedText
      if (idSelected === 'cancel') {
        term.green(`\nCancelled config bot\n`)
      } else {
        const configBotInquirer = new ConfigBotInquirer(that)
        const bot = userApi.appState.getBot(idSelected)
        configBotInquirer.startInquiry(bot.strategy.getName()).then(async userResponse => {
          await userApi.configBot(idSelected, userResponse)
          term.green(`Bot with ID ${bot.id} configured`)
          that.awaitInput()
        }).catch(error => errorLogger().error(error))
      }
    })
  }
}


module.exports = CliUI
