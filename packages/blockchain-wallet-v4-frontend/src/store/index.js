import { createStore, applyMiddleware, compose } from 'redux'
import createSagaMiddleware from 'redux-saga'
import { persistStore, autoRehydrate } from 'redux-persist'
import { createHashHistory } from 'history'
import { connectRouter, routerMiddleware } from 'connected-react-router'
import appConfig from 'config'
import { coreMiddleware } from 'blockchain-wallet-v4/src'
import {
  createWalletApi,
  Socket,
  ApiSocket,
  HorizonStreamingService
} from 'blockchain-wallet-v4/src/network'
import { serializer } from 'blockchain-wallet-v4/src/types'
import { actions, rootSaga, rootReducer, selectors } from 'data'
import {
  autoDisconnection,
  streamingXlm,
  webSocketBch,
  webSocketBtc,
  webSocketEth,
  webSocketRates
} from '../middleware'
import { head } from 'ramda'
import Bitcoin from 'bitcoinjs-lib'
import BitcoinCash from 'bitcoinforksjs-lib'

const devToolsConfig = {
  maxAge: 1000,
  serialize: serializer,
  actionsBlacklist: [
    // '@@redux-form/INITIALIZE',
    // '@@redux-form/CHANGE',
    // '@@redux-form/REGISTER_FIELD',
    // '@@redux-form/UNREGISTER_FIELD',
    // '@@redux-form/UPDATE_SYNC_ERRORS',
    // '@@redux-form/FOCUS',
    // '@@redux-form/BLUR',
    // '@@redux-form/DESTROY',
    // '@@redux-form/RESET',
    // '@@redux-ui/MOUNT_UI_STATE',
    // '@@redux-ui/UNMOUNT_UI_STATE'
  ]
}

const configureStore = () => {
  const history = createHashHistory()
  const sagaMiddleware = createSagaMiddleware()
  // TODO: should these tools be allowed in upper environments!?
  const composeEnhancers = window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__
    ? window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__(devToolsConfig)
    : compose
  const walletPath = appConfig.WALLET_PAYLOAD_PATH
  const kvStorePath = appConfig.WALLET_KVSTORE_PATH
  const isAuthenticated = selectors.auth.isAuthenticated

  return fetch('/Resources/wallet-options-v4.json')
    .then(res => res.json())
    .then(options => {
      const apiKey = '1770d5d9-bcea-4d28-ad21-6cbd5be018a8'
      // TODO: deprecate when wallet-options-v4 is updated on prod
      const socketUrl = head(options.domains.webSocket.split('/inv'))
      const horizonUrl = options.domains.horizon
      const btcSocket = new Socket({
        options,
        url: `${socketUrl}/inv`
      })
      const bchSocket = new Socket({
        options,
        url: `${socketUrl}/bch/inv`
      })
      const ethSocket = new Socket({
        options,
        url: `${socketUrl}/eth/inv`
      })
      const ratesSocket = new ApiSocket({
        options,
        url: `${socketUrl}/nabu-gateway/markets/quotes`,
        maxReconnects: 3
      })
      const xlmStreamingService = new HorizonStreamingService({
        url: horizonUrl
      })
      const getAuthCredentials = () =>
        selectors.modules.profile.getAuthCredentials(store.getState())
      const networks = {
        btc: Bitcoin.networks[options.platforms.web.bitcoin.config.network],
        bch: BitcoinCash.networks[options.platforms.web.bitcoin.config.network],
        eth: options.platforms.web.ethereum.config.network,
        xlm: options.platforms.web.xlm.config.network
      }
      const api = createWalletApi({
        options,
        apiKey,
        getAuthCredentials,
        networks
      })

      const store = createStore(
        connectRouter(history)(rootReducer),
        composeEnhancers(
          applyMiddleware(
            sagaMiddleware,
            routerMiddleware(history),
            coreMiddleware.kvStore({ isAuthenticated, api, kvStorePath }),
            webSocketBtc(btcSocket),
            webSocketBch(bchSocket),
            webSocketEth(ethSocket),
            streamingXlm(xlmStreamingService, api),
            webSocketRates(ratesSocket),
            coreMiddleware.walletSync({ isAuthenticated, api, walletPath }),
            autoDisconnection()
          ),
          autoRehydrate()
        )
      )
      persistStore(store, { whitelist: ['session', 'preferences', 'cache'] })
      sagaMiddleware.run(rootSaga, {
        api,
        bchSocket,
        btcSocket,
        ethSocket,
        ratesSocket,
        networks,
        options
      })

      // TODO: remove in production
      window.createTestXlmAccounts = () => {
        store.dispatch(actions.core.data.xlm.createTestAccounts())
      }

      return {
        store,
        history
      }
    })
}

export default configureStore
