/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Node create a selection of events.
 *
 * @module selection
 *
 * @author Henning Klages
 *
 * @since 2021-01-16
*/

'use strict'

const { PACKAGE_PREFIX, REGEX_IP, REGEX_DNS } = require('./Globals.js')

const { discoverIpByUuid } = require('./Discovery.js')

const { isTruthyProperty } = require('./Helper')

const { filterAndImproveServiceData } = require('./Extensions')

const { SonosDevice, SonosEventListener, ServiceEvents } = require('@svrooij/sonos/lib')

const request = require('axios').default

const Dns = require('dns')
const dnsPromises = Dns.promises

const debug = require('debug')(`${PACKAGE_PREFIX}:selection`)

module.exports = function (RED) {

  /** Create event node notification based on configuration and send messages
   * @param  {object} config current node configuration data
  */

  function sonosEventsSelectionNode (config) {
    debug('method >>%s', 'sonosEventsSelectionNode')
    RED.nodes.createNode(this, config)

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const node = this
    node.status({})

    // build {service: {event: outputIndex}} map from the dialog
    const eventsByServices = {}
    const subscriptions = config.events
    for (let i = 0; i < subscriptions.length; i++) {
      const [serviceName, eventName] = subscriptions[i].fullName.split('.')
      if (!isTruthyProperty(eventsByServices, [serviceName])) {
        eventsByServices[serviceName] = {}
      }
      eventsByServices[serviceName][eventName] = i
    }

    const refreshSeconds = (Number(config.refreshSeconds) > 0) ? Number(config.refreshSeconds) : 60
    let player = null
    let subscribed = false

    // Resolve the target player to a current ipv4 address.
    // Preferred: durable uuid -> discover current ip (survives DHCP changes).
    // Fallback: ipv4 address or DNS name in playerHostname (non-breaking).
    async function resolveIp () {
      if (isTruthyProperty(config, ['playerUuid']) && config.playerUuid !== '') {
        const ip = await discoverIpByUuid(config.playerUuid)
        if (!ip) throw new Error('player uuid not found on network')
        return ip
      }
      if (REGEX_IP.test(config.playerHostname)) {
        return config.playerHostname
      }
      if (REGEX_DNS.test(config.playerHostname)) {
        const ipv4Array = await dnsPromises.resolve4(config.playerHostname)
        return ipv4Array[0]
      }
      throw new Error('no valid player uuid or ipv4/DNS name')
    }

    async function subscribeAt (ip) {
      player = new SonosDevice(ip)
      await subscribeToMultipleEvents(node, player, eventsByServices)
    }

    // initial subscribe, retrying until the player is reachable so a SID is
    // always established (RefreshEventSubscriptions is a no-op without one)
    async function establishSubscription () {
      try {
        const ip = await resolveIp()
        await subscribeAt(ip)
        subscribed = true
        node.status({ fill: 'green', shape: 'ring', text: `connected: ${player.host}` })
      } catch (error) {
        subscribed = false
        node.status({ fill: 'red', shape: 'ring', text: 'disconnected: ' + error.message })
        node.debug(`error subscribe>>${JSON.stringify(error, Object.getOwnPropertyNames(error))}`)
        node.retryTimer = setTimeout(establishSubscription, refreshSeconds * 1000)
      }
    }
    establishSubscription()

    // watchdog: renew on a tight interval so a stale SID after a player
    // power-cycle re-subscribes within refreshSeconds. If the renew fails the
    // player may be gone or moved to a new ip - re-resolve (by uuid) and, if the
    // address changed, rebuild the device and re-subscribe at the new ip.
    node.refreshTimer = setInterval(function () {
      if (!subscribed || !player) return
      player.RefreshEventSubscriptions()
        .catch(async () => {
          try {
            const ip = await resolveIp()
            if (ip && ip !== player.host) {
              await cancelAllSubscriptions(player, eventsByServices)
              await subscribeAt(ip)
              node.status({ fill: 'green', shape: 'ring', text: `reconnected: ${player.host}` })
            }
          } catch (error) {
            node.debug(`rediscover failed >>${error.message}`)
          }
        })
    }, refreshSeconds * 1000)

    // any input message forces an immediate re-resolve + re-subscribe
    node.on('input', function (msg, send, done) {
      (async function () {
        const ip = await resolveIp()
        if (!player || ip !== player.host) {
          if (player) await cancelAllSubscriptions(player, eventsByServices)
          await subscribeAt(ip)
        } else {
          await player.RefreshEventSubscriptions()
        }
        subscribed = true
        node.status({ fill: 'green', shape: 'dot', text: `resubscribed: ${player.host}` })
      })()
        .then(() => { if (done) done() })
        .catch(error => {
          node.status({ fill: 'red', shape: 'ring', text: 'resubscribe failed: ' + error.message })
          if (done) done(error)
        })
    })

    // unsubscribe to all, when node is deleted (redeployed does delete)
    node.on('close', function (done) {
      if (node.refreshTimer) { clearInterval(node.refreshTimer) }
      if (node.retryTimer) { clearTimeout(node.retryTimer) }
      if (!player) { done(); return }
      cancelAllSubscriptions(player, eventsByServices)
        .then(() => {
          debug('nodeOnClose >>all subscriptions canceled')
          done()
        })
        .catch(error => {
          debug(`nodeOnClose error during cancel subscriptions >>${JSON.stringify(error, Object.getOwnPropertyNames(error))}`)
          done(error)
        })
    })

    return true
  }

  RED.nodes.registerType('sonosevents-selection', sonosEventsSelectionNode)
}

/** Subscribe to multiple services, filter properties and send messages for a given player.
 * @param {object} node current node
 * @param {object} player sonos-ts player object
 * @param {object} eventsByServices such as
 *                  "RenderingControlService":{"raw":0}} 0 stands for output index
 *
 * @returns {promise<string>} host:port OK
 *
 * @throws errors isTruthyPropertyStringNotEmpty, isTruthyProperty
 */
async function subscribeToMultipleEvents (node, player, eventsByServices) {
  debug('method >>%s', 'asyncSubscribeToMultipleEvents')
  // general definition for this node
  let errorCount = 0
  const serviceArray = Object.keys(eventsByServices)

  // get number of events = number of outputs
  const outputs = serviceArray.reduce(function (acc, current) {
    return acc + Object.keys(eventsByServices[current]).length
  }, 0)

  // validate ip (with time out) and get the device capabilities
  let capabilities = []
  let response
  try {
    response = await request.get(`http://${player.host}:${player.port}/info`, { timeout: 4000 })
  } catch (error) {
    debug('invalid player - http request >>%s', JSON.stringify(error.message))
    // TODO check ECONNREFUSED
    throw new Error('invalid player - error or timed out')
  }
  if (isTruthyProperty(response, ['data', 'device', 'capabilities'])) {
    capabilities = response.data.device.capabilities
  } else {
    throw new Error('invalid player - missing capabilities)')
  }

  // do events "DevicePropertiesService.micEnabled", "AudioInService.lineInConnected"
  // match capabilities: VOICE, LINE_IN, (HT_PLAYBACK to be implemented)
  if (isTruthyProperty(eventsByServices, ['DevicePropertiesService', 'micEnabled'])
      && !capabilities.includes('VOICE')) {
    throw new Error('micEnabled not possible')
  }
  if (isTruthyProperty(eventsByServices, ['AudioInService', 'lineInConnected'])
    && !capabilities.includes('LINE_IN')) {
    throw new Error('lineInConnected not possible')
  }

  // what port, host ...
  debug('event listener status >>%s',
    JSON.stringify(SonosEventListener.DefaultInstance.GetStatus()))

  // subscribe to the specified services/events
  serviceArray.forEach(async function (serviceName) {
    // const response = await ... does not provide any relevant information
    await player[serviceName].Events.on(ServiceEvents.ServiceEvent,
      sendServiceMsgs.bind(this, serviceName, eventsByServices[serviceName], outputs))
    debug('subscribed to >>%s', serviceName)
  })

  return SonosEventListener.DefaultInstance.GetStatus().port

  // .............. sendMsg functions ...............
  // only output to requested output lines, prepare data
  // uses globally declared objects node, msgArray

  async function sendServiceMsgs (serviceName, mapEventToOutput, outputs, raw) {
    debug('new event >>', serviceName)

    try {
      // define msg s
      const topicPrefix = `${player.host}/${serviceName}/`
      const improved = await filterAndImproveServiceData(serviceName, raw)

      const eventNames = Object.keys(mapEventToOutput)
      eventNames.forEach(eventName => {
        if (isTruthyProperty(mapEventToOutput, [eventName])) {
          const msg = new Array(outputs).fill(null)
          const topic = topicPrefix + eventName
          if (eventName === 'raw') {
            // raw means no event filter, original data
            msg[mapEventToOutput[eventName]] = { 'payload': raw, topic }
            node.send(msg)
          } else {
            // we have to remove null events
            if (improved[eventName] !== null) {
              const payload = improved[eventName]
              msg[mapEventToOutput[eventName]] = { payload, topic, raw }
              node.send(msg)
            }
          }
        }
      })
    } catch (error) {
      errorCount++
      node.status({ fill: 'yellow', shape: 'ring', text: `error count ${errorCount}` })
      node.debug(`error processing AVTransport event >>${JSON.stringify(error, Object.getOwnPropertyNames(error))}`)
    }
  }
}

async function cancelAllSubscriptions (player, eventsByServices) {

  const serviceArray = Object.keys(eventsByServices)
  serviceArray.forEach(async function (serviceName) {
    await player[serviceName].Events.removeAllListeners(ServiceEvents.ServiceEvent)
    debug('unsubscribed to >>%s', serviceName)
  })
}
