const WEBSOCKET_HOSTS = {
  MainNet: 'ws.switcheo.io',
  TestNet: 'test-ws.switcheo.io',
  DevNet: 'dev-ws.switcheo.io',
}
const CONTRACT_HASHES = {
  MainNet: {
    neo: 'a32bcf5d7082f740a4007b16e812cf66a457c3d4',
    eth: '0x7ee7ca6e75de79e618e88bdf80d0b1db136b22d0',
    eos: 'pwrdbyobolus',
  },
  TestNet: {
    neo: '58efbb3cca7f436a55b1a05c0f36788d2d9a032e',
    eth: '0x4d19fd42e780d56ff6464fe9e7d5158aee3d125d',
    eos: 'toweredbyob2',
  },
  DevNet: {
    neo: 'd524fbb2f83f396368bc0183f5e543cae54ef532',
    eth: '0xfe76be890a14921fe09682eccea416b708d620d3',
    eos: 'oboluswitch4',
  }
}

const FILE_PATHS = {
  botsDirectory: '../bots',
}

module.exports = {
  WEBSOCKET_HOSTS,
  CONTRACT_HASHES,
  FILE_PATHS,
}