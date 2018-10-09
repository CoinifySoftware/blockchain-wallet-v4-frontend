import { Observable } from 'rxjs'
import React from 'react'
import { prop } from 'ramda'
import { FormattedMessage } from 'react-intl'
import TransportU2F from '@ledgerhq/hw-transport-u2f'
import Btc from '@ledgerhq/hw-app-btc'

import {
  createXpubFromChildAndParent,
  getParentPath
} from 'blockchain-wallet-v4/src/utils/btc'
import { Types } from 'blockchain-wallet-v4/src'
import { deriveAddressFromXpub } from 'blockchain-wallet-v4/src/utils/eth'
import firmware from './firmware'
import constants from './constants'

const ethAccount = (xpub, label) => ({
  label: label,
  archived: false,
  correct: true,
  addr: deriveAddressFromXpub(xpub)
})

const btcAccount = (xpub, label) => Types.HDAccount.js(label, null, xpub)

/**
 * Creates device socket
 * @param {Transport} transport - Current device transport
 * @param {String} url - The web socket url to connect to
 * @returns {Observable} the final socket result
 */
/* eslint-disable */
const createDeviceSocket = (transport, url) => {
  return Observable.create(o => {
    let ws, lastMessage

    try {
      ws = new WebSocket(url)
    } catch (err) {
      o.error(err.message, { url })
      return () => {}
    }

    ws.onopen = () => {
      console.info('OPENED', { url })
    }

    ws.onerror = e => {
      console.info('ERROR', { message: e.message, stack: e.stack })
      o.error(e.message, { url })
    }

    ws.onclose = () => {
      console.info('CLOSE')
      o.next(lastMessage || '')
      o.complete()
    }

    ws.onmessage = async rawMsg => {
      try {
        const msg = JSON.parse(rawMsg.data)
        if (!(msg.query in handlers)) {
          throw new Error({ message: 's0ck3t' }, { url })
        }
        console.info('RECEIVE', msg)
        await handlers[msg.query](msg)
      } catch (err) {
        console.info('ERROR', { message: err.message, stack: err.stack })
        o.error(err)
      }
    }

    const send = (nonce, response, data) => {
      const msg = {
        nonce,
        response,
        data
      }
      console.info('SEND', msg)
      const strMsg = JSON.stringify(msg)
      ws.send(strMsg)
    }

    const handlers = {
      exchange: async input => {
        const { data, nonce } = input
        const res = await transport.exchange(Buffer.from(data, 'hex'))
        const status = res.slice(res.length - 2)
        const buffer = res.slice(0, res.length - 2)
        const strStatus = status.toString('hex')
        send(
          nonce,
          strStatus === '9000' ? 'success' : 'error',
          buffer.toString('hex')
        )
      },

      bulk: async input => {
        const { data, nonce } = input
        let lastStatus // Execute all apdus and collect last status
        let i = 0
        for (const apdu of data) {
          i++
          const res = await transport.exchange(Buffer.from(apdu, 'hex'))
          lastStatus = res.slice(res.length - 2)
          if (lastStatus.toString('hex') !== '9000') break
        }
        if (!lastStatus) throw new Error({ message: 's0ck3t' }, { url })
        const isSuccess =
          lastStatus.toString('hex') === '9000' || data.length === i

        send(
          nonce,
          isSuccess ? 'success' : 'error',
          isSuccess ? '' : lastStatus.toString('hex')
        )
      },

      success: msg => {
        lastMessage = msg.data || msg.result
        ws.close()
      },

      error: msg => {
        console.info('ERROR', { data: msg.data })
        ws.close()
        throw new Error(msg.data, { url })
      }
    }

    return () => {
      if (ws.readyState === 1) {
        lastMessage = null
        ws.close()
      }
    }
  })
}
/* eslint-enable */

/**
 * Gets and parses full device information from api response
 * @param {Transport} transport - Current device transport
 * @returns {Promise} full device information
 */
const getDeviceInfo = transport => {
  return new Promise((resolve, reject) => {
    firmware.getDeviceFirmwareInfo(transport).then(
      res => {
        const { seVersion } = res
        const { targetId, mcuVersion, flags } = res
        const parsedVersion =
          seVersion.match(
            /([0-9]+.[0-9])+(.[0-9]+)?((?!-osu)-([a-z]+))?(-osu)?/
          ) || []
        const isOSU = typeof parsedVersion[5] !== 'undefined'
        const providerName = parsedVersion[4] || ''
        const providerId = constants.providers[providerName]
        const isBootloader = targetId === 0x01000001
        const majMin = parsedVersion[1]
        const patch = parsedVersion[2] || '.0'
        const fullVersion = `${majMin}${patch}${
          providerName ? `-${providerName}` : ''
        }`
        resolve({
          targetId,
          seVersion: majMin + patch,
          isOSU,
          mcuVersion,
          isBootloader,
          providerName,
          providerId,
          flags,
          fullVersion
        })
      },
      err => {
        reject(err)
      }
    )
  })
}

/**
 * Maps a socket error code to a human readable error
 * @param {Promise} promise - Current device transport
 * @returns {Promise} a catch function that returns human error
 */
const mapSocketError = promise => {
  return promise.catch(err => {
    switch (true) {
      case err.message.endsWith('6985'):
        return {
          err,
          errMsg: () => (
            <FormattedMessage
              id='lockbox.service.messages.connectionrefused'
              defaultMessage='Device connection was refused'
            />
          )
        }
      case err.message.endsWith('6982'):
        return {
          err,
          errMsg: () => (
            <FormattedMessage
              id='lockbox.service.messages.devicelocked'
              defaultMessage='Device locked and unable to communicate'
            />
          )
        }
      case err.message.endsWith('6a84') || err.message.endsWith('6a85'):
        return {
          err,
          errMsg: () => (
            <FormattedMessage
              id='lockbox.service.messages.storagespace'
              defaultMessage='Insufficient storage space on device'
            />
          )
        }
      case err.message.endsWith('6a80') || err.message.endsWith('6a81'):
        return {
          err,
          errMsg: () => (
            <FormattedMessage
              id='lockbox.service.messages.appalreadyinstalled'
              defaultMessage='App already installed'
            />
          )
        }
      case err.message.endsWith('6a83'):
        return {
          err,
          errMsg: () => (
            <FormattedMessage
              id='lockbox.service.messages.btcapprequired'
              defaultMessage='Unable to remove BTC app as it is required by others'
            />
          )
        }
      case err.message.endsWith('s0ck3t'):
        return {
          err,
          errMsg: () => (
            <FormattedMessage
              id='lockbox.service.messages.socketerror'
              defaultMessage='Socket connection failed'
            />
          )
        }
      default:
        return {
          err,
          errMsg: () => (
            <FormattedMessage
              id='lockbox.service.messages.unknownerror'
              defaultMessage='An unknown error has occurred'
            />
          )
        }
    }
  })
}

/**
 * Determines correct scrambleKey to use for device connection
 * @param {String} app - Current app requested
 * @param {String} deviceType - Either 'ledger' or 'blockchain'
 * @returns {String} the scrambleKey for connection
 */
const getScrambleKey = (app, deviceType) => {
  return constants.scrambleKeys[deviceType][app]
}

/**
 * Derives xPubs from device
 * @param {TransportU2F} btcApp - The BTC app connection
 * @returns {Object} the derived xPubs
 */
const deriveDeviceInfo = async btcApp => {
  let btcPath = "44'/0'/0'"
  let bchPath = "44'/145'/0'"
  let ethPath = "44'/60'/0'/0/0"

  let btcChild = await btcApp.getWalletPublicKey(btcPath)
  let bchChild = await btcApp.getWalletPublicKey(bchPath)
  let ethChild = await btcApp.getWalletPublicKey(ethPath)
  let btcParent = await btcApp.getWalletPublicKey(getParentPath(btcPath))
  let bchParent = await btcApp.getWalletPublicKey(getParentPath(bchPath))
  let ethParent = await btcApp.getWalletPublicKey(getParentPath(ethPath))
  const btc = createXpubFromChildAndParent(btcPath, btcChild, btcParent)
  const bch = createXpubFromChildAndParent(bchPath, bchChild, bchParent)
  const eth = createXpubFromChildAndParent(ethPath, ethChild, ethParent)

  return { btc, bch, eth }
}

/**
 * Generates metadata entry new device save
 * @param {Object} newDevice - The new device info with xPubs
 * @param {String} deviceName - The users name for the new device
 * @returns {Object} the metadata entry to save
 */
const generateAccountsMDEntry = (newDevice, deviceName) => {
  const deviceType = prop('type', newDevice)

  try {
    const { btc, bch, eth } = prop('info', newDevice)

    return {
      device_type: deviceType,
      device_name: deviceName,
      btc: { accounts: [btcAccount(btc, deviceName + ' - BTC Wallet')] },
      bch: { accounts: [btcAccount(bch, deviceName + ' - BCH Wallet')] },
      eth: {
        accounts: [ethAccount(eth, deviceName + ' - ETH Wallet')],
        last_tx: null,
        last_tx_timestamp: null
      }
    }
  } catch (e) {
    throw new Error('mising_device_info')
  }
}

/**
 * Creates and returns a new BTC/BCH app connection
 * @param {String} app - The app to connect to (BTC, DASHBOARD, etc)
 * @param {String} deviceType - Either 'ledger' or 'blockchain'
 * @param {TransportU2F<Btc>} transport - Transport with BTC/BCH as scrambleKey
 * @returns {Btc} Returns a BTC/BCH connection
 */
const createBtcBchConnection = (app, deviceType, transport) => {
  const scrambleKey = getScrambleKey(app, deviceType)
  return new Btc(transport, scrambleKey)
}

/**
 * Polls for a given application to open on the device
 * @async
 * @param {String} deviceType - Either 'ledger' or 'blockchain'
 * @param {String} app - The app to connect to (BTC, DASHBOARD, etc)
 * @param {Number} timeout - Length of time in ms to wait for a connection
 * @returns {Promise<TransportU2F>} Returns a connected Transport or Error
 */
const pollForAppConnection = (deviceType, app, timeout = 60000) => {
  if (!deviceType || !app) throw new Error('Missing required params')

  return new Promise((resolve, reject) => {
    // create transport
    TransportU2F.open().then(transport => {
      // get scrambleKey
      const scrambleKey = getScrambleKey(app, deviceType)
      // configure transport
      // transport.setDebugMode(true)
      transport.setExchangeTimeout(timeout)
      transport.setScrambleKey(scrambleKey)
      // send NO_OP cmd until response is received (success) or timeout is hit (reject)
      transport.send(...constants.apdus.no_op).then(
        () => {},
        res => {
          // since no_op wont be recognized by any app as a valid cmd, this is always going
          // to fail but a response, means a device is connected and unlocked
          if (res.originalError) {
            reject(res.originalError.metaData)
          }

          resolve({ app, transport })
        }
      )
    })
  })
}

/**
 * Formats a firmware hash
 * @async
 * @param {String} hash - THe unformatted firmware hash
 * @returns {String} Returns the formatted hash
 */
const formatFirmwareHash = hash => {
  if (!hash) {
    return ''
  }
  hash = hash.toUpperCase()
  const length = hash.length
  const half = Math.ceil(length / 2)
  const start = hash.slice(0, half)
  const end = hash.slice(half)
  return [start, end].join('\n')
}

/**
 * Converts a firmware version into human displayable format
 * @async
 * @param {String} raw - THe unformatted firmware version
 * @returns {String} Returns the formatted firmware name
 */
const formatFirmwareDisplayName = raw => {
  return raw.endsWith('-osu') ? raw.replace('-osu', '') : raw
}

export default {
  createDeviceSocket,
  createBtcBchConnection,
  deriveDeviceInfo,
  formatFirmwareDisplayName,
  formatFirmwareHash,
  generateAccountsMDEntry,
  getDeviceInfo,
  getScrambleKey,
  mapSocketError,
  pollForAppConnection
}