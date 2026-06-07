/**
 * Collection of methods to handle the discovery of player.
 * Method: UDP SSDP broadcast port 1900.
 * Part of SONOS-plus.
 *
 * @module Discovery
 *
 * @author Henning Klages
 *
 * @since 2023-01-05
 *
*/

'use strict'
const { PACKAGE_PREFIX } = require('./Globals.js')

const { getGroupsAll: getGroupsAll } = require('./Commands.js')

const { SonosDevice } = require('@svrooij/sonos/lib')
const SonosPlayerDiscovery   = require('./Discovery-base-hk.js')

const debug = require('debug')(`${PACKAGE_PREFIX}discovery`)

/** SSDP-discover one player, then enumerate the whole household from it.
 * Discovering the first one and asking it for the rest is reliable/deterministic.
 * @returns {Promise<object[]>} flat list of members ({urlObject, playerName, uuid, ...})
 * @throws {error} all methods
 */
async function discoverFlatList () {
  const deviceDiscovery = new SonosPlayerDiscovery()
  const firstPlayerIpv4 = await deviceDiscovery.discoverOnePlayer()
  debug('first player found >>%s', firstPlayerIpv4)
  const firstPlayer = new SonosDevice(firstPlayerIpv4)
  const allGroups = await getGroupsAll(firstPlayer)
  const flatList = [].concat.apply([], allGroups)
  debug('got players, in total >>%s', flatList.length)
  return flatList
}

module.exports = {

  /** Discover all players, returns list of {label, value} with value = ip host.
   * @returns {Promise<object[]>} {'label', value}
   * @throws {error} all methods
   */
  discoverAllPlayerWithHost: async () => {
    debug('method:%s', 'discoverAllPlayerWithHost')
    const flatList = await discoverFlatList()
    return flatList.map((item) => {
      return {
        'label': `${item.urlObject.hostname} for ${item.playerName}`,
        'value': item.urlObject.hostname
      }
    })
  },

  /** Discover all zones, returns list of {label, value, uuid, host, playerName}
   * with value = durable uuid (for persisting a selection that survives IP changes).
   * @returns {Promise<object[]>}
   * @throws {error} all methods
   */
  discoverAllZones: async () => {
    debug('method:%s', 'discoverAllZones')
    const flatList = await discoverFlatList()
    return flatList.map((item) => {
      return {
        'label': `${item.playerName} (${item.urlObject.hostname})`,
        'value': item.uuid,
        'uuid': item.uuid,
        'host': item.urlObject.hostname,
        'playerName': item.playerName
      }
    })
  },

  /** Resolve a durable uuid to its current ip host via discovery.
   * @param {string} uuid the player RINCON uuid
   * @returns {Promise<string|null>} current ip host, or null if not on the network
   * @throws {error} discovery methods (e.g. no players found)
   */
  discoverIpByUuid: async (uuid) => {
    debug('method:%s', 'discoverIpByUuid')
    const flatList = await discoverFlatList()
    const found = flatList.find((item) => item.uuid === uuid)
    return (found ? found.urlObject.hostname : null)
  }

}
