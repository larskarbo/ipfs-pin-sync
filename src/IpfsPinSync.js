import { Configuration, RemotePinningServiceClient, Status } from '@ipfs-shipyard/pinning-service-client'
import Bottleneck from "bottleneck";

export default class IpfsPinSync {
    constructor (sourceConfigOptions, destinationConfigOptions) {
        if (typeof sourceConfigOptions !== "undefined" && sourceConfigOptions !== {}) {
            this.#connectToSource(sourceConfigOptions)
        }

        if (typeof destinationConfigOptions !== "undefined" && destinationConfigOptions !== {}) {
            this.#connectToDestination(destinationConfigOptions)
        }
    }

    #connectToSource(sourceConfigOptions) {
        if (!sourceConfigOptions.endpointUrl) {
            throw new Error(`Source endpointUrl must be set`)
        }
        if (!sourceConfigOptions.accessToken) {
            throw new Error(`Source accessToken must be set`)
        }

        const sourceConfig = new Configuration({
            endpointUrl: sourceConfigOptions.endpointUrl, // the URI for your pinning provider, e.g. `http://localhost:3000`
            accessToken: sourceConfigOptions.accessToken, // the secret token/key given to you by your pinning provider
        })

        this.sourceClient = new RemotePinningServiceClient(sourceConfig)
    }

    #connectToDestination(destinationConfigOptions) {
        if (!destinationConfigOptions.endpointUrl) {
            throw new Error(`Destination endpointUrl must be set`)
        }
        if (!destinationConfigOptions.accessToken) {
            throw new Error(`Destination accessToken must be set`)
        }

        this.destinationConfig = destinationConfigOptions;

        const destinationConfig = new Configuration({
            endpointUrl: destinationConfigOptions.endpointUrl, // the URI for your pinning provider, e.g. `http://localhost:3000`
            accessToken: destinationConfigOptions.accessToken, // the secret token/key given to you by your pinning provider
        })

        this.destinationClient = new RemotePinningServiceClient(destinationConfig)
    }

    #getOldestPinCreateDate (pinsResult) {
        let oldestCreateDate = new Date()
        for (let pin of pinsResult) {
            if (pin.created < oldestCreateDate) {
                oldestCreateDate = pin.created
            }
        }
        return oldestCreateDate
    }

    listSource () {
        return this.#list(this.sourceClient);
    }

    listDestination () {
        return this.#list(this.destinationClient);
    }

    async #list (client) {
        let pinsExistToCheck = true
        let earliestPinInList = null
        let pinList = [];

        while (pinsExistToCheck === true) {
            // Get 1000 Successful Pins
            let pinsGetOptions = {
                limit: 500,
                status: new Set([Status.Pinned, Status.Pinning, Status.Queued]) // requires a set, and not an array
            }
            if (earliestPinInList != null) {
                pinsGetOptions.before = earliestPinInList
            }

            const {count, results} = await client.pinsGet(pinsGetOptions)

            console.log(count, results)
            pinList = pinList.concat(Array.from(results));

            earliestPinInList = this.#getOldestPinCreateDate(results)

            console.log(`Results Length: ${results.size}`)
            if (results.size !== 1000) {
                pinsExistToCheck = false;
            }
        }

        return pinList;
    }

    async sync (progressCallback) {
        const syncLimiter = new Bottleneck({
            reservoir: 25,
            reservoirRefreshInterval: 1000,
            reservoirRefreshAmount: 25,
            maxConcurrent: 10
        })
        const throttledAddPin = syncLimiter.wrap(this.#addPin);

        const sourcePins = await this.listSource();

        // Loop over list of pins and pin to destinationClient
        let addPinRequests = [];
        let pinsAdded = 0;
        let pinKeys = new Set();
        let duplicateKeys = {};
        for (let sourcePin of sourcePins) {
            if (this.destinationConfig.endpointUrl.includes('.filebase.') || this.destinationConfig.endpointUrl.includes('.fbase.')) {
                // Check if pin name is a duplicate and rename accordingly
                if (pinKeys.has(sourcePin.pin.name) === true) {
                    duplicateKeys[sourcePin.pin.name] = duplicateKeys[sourcePin.pin.name] || 0
                    duplicateKeys[sourcePin.pin.name] = duplicateKeys[sourcePin.pin.name] + 1
                    sourcePin.pin.name = `${sourcePin.pin.name} [${duplicateKeys[sourcePin.pin.name]}]`
                }

                // Add new duplicated name to pin key set to ensure no duplicates caused by renaming
                pinKeys.add(sourcePin.pin.name);
            }

            const pinPostOptions = {
                pin: {
                    cid: sourcePin.pin.cid,
                    name: sourcePin.pin.name,
                    origins: sourcePin.pin.origins,
                    meta: sourcePin.pin.meta
                }
            }

            const addPinRequest = throttledAddPin(this.destinationClient, pinPostOptions);

            // Provide Progress Updates
            addPinRequest.then(() => {
                if (progressCallback) {
                    pinsAdded = pinsAdded + 1;
                    progressCallback({
                        percent: (100/sourcePins.length) * pinsAdded,
                        count: pinsAdded
                    });
                }
            })

            addPinRequests.push(addPinRequest);
        }

        // Wait for all Add Request to Finish
        await Promise.all(addPinRequests);

        return true;
    }

    async #addPin (client, pinPostOptions) {
        await client.pinsPost(pinPostOptions);
    }
}
