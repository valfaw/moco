#!/usr/bin/env node
// Author: Javier Campos López <mezie@fastmail.com>
// License: Non-Profit Open Software License 3.0 (NPOSL-3.0)
'use strict'

// Imports
const fs = require(`fs`)
const http = require(`http`)
const readline = require(`readline`)
const url = require(`url`)

// Global constants
const appName = `moco`
const appVersion = `0.1`
const templateConfigFile = `config.moco.json`

// Modifications to the standard classes
String.prototype.capitalize = function (lower) {
    return (lower ? this.toLowerCase() : this).replace(/(?:^|\s)\S/g, function (a) { return a.toUpperCase() })
}

if (!String.isString) {
    String.isString = (str) => {
        return Object.prototype.toString.call(str) === `[object String]`
    }
}

if (!Boolean.isBoolean) {
    Boolean.isBoolean = (bool) => {
        return Object.prototype.toString.call(bool) === `[object Boolean]`
    }
}

// Auxiliary functions
const HelpMode = Object.freeze({
    USAGE: Symbol(`usage`),
    USAGE_EXTENDED: Symbol(`usage_extended`),
    COMMANDS: Symbol(`commands`)
})

const printHelp = (helpMode) => {
    if (helpMode === HelpMode.USAGE || helpMode === HelpMode.USAGE_EXTENDED) {
        console.log(`usage: node ${appName}.js [help | run <path> | template [<path>]]`)
    }

    if (helpMode === HelpMode.USAGE_EXTENDED) {
        console.log(`help`)
        console.log(`\tPrint this message`)
        console.log(`run <path>, <path> : string`)
        console.log(`\tRun ${appName} using configuration file stored in <path>`)
        console.log(`template [<path>], <path> : string`)
        console.log(`\tConvenience command, saves a configuration template file to <path>. If <path> not specified \`${templateConfigFile}\` will be created in the current directory`)
    }

    if (helpMode === HelpMode.COMMANDS) {
        console.log(`help`)
        console.log(`\tPrint the list of ${appName} commands available`)
        console.log(`list`)
        console.log(`\tList all endpoints`)
        console.log(`info <id>, <id> : integer`)
        console.log(`\tPrint the endpoint <id> information in readable way`)
        console.log(`toggle <id>, <id> : integer`)
        console.log(`\tEnable/Disable endpoint <id>`)
        console.log(`response <id> <HTTPStatusCode>, <id> : integer, <HTTPStatusCode> : {100 - 999}`)
        console.log(`\tSet endpoint <id> to answer with status code <HTTPStatusCode>`)
    }
}

const safeForEachHeader = (headers, callback) => {
    // It will apply the callback to each header only if the headers object exists
    let headersArray = []
    if (headers) {
        headersArray = Object.keys(headers)
    }
    headersArray.forEach((header, index, array) => callback(header, index, array))
}

// Get configuration file path
let configFilePath = null
if (/^help$/i.test(process.argv[2])) {
    if (process.argv.length !== 3) {
        printHelp(HelpMode.USAGE)
        process.exit()
    }

    printHelp(HelpMode.USAGE_EXTENDED)
    process.exit()
} else if (/^run$/i.test(process.argv[2])) {
    if (process.argv.length !== 4) {
        printHelp(HelpMode.USAGE)
        process.exit()
    }

    configFilePath = process.argv[3]
} else if (/^template$/i.test(process.argv[2])) {
    if (process.argv.length > 4) {
        printHelp(HelpMode.USAGE)
        process.exit()
    }

    const path = process.argv[3] !== undefined ? process.argv[3] : templateConfigFile
    const configTemplate = JSON.stringify({
        port: 8080,
        maskedHost: `example.com`,
        endpoints: [
            {
                request: {
                    path: `path/to/{*}/endpoint`,
                    method: `GET`,
                    headers: {
                        Accept: `*/*`
                    }
                },
                responses: [
                    {
                        statusCode: 200,
                        headers: {
                            'Content-Type': `application/json`,
                            'User-Agent': `${appName}/${appVersion}`
                        },
                        body: {
                            message: `Success!`
                        }
                    },
                    {
                        statusCode: 503,
                        headers: {
                            'Content-Type': `application/json`,
                            'User-Agent': `${appName}/${appVersion}`
                        },
                        body: {
                            message: `Unavailable`
                        }
                    }
                ]
            }
        ]
    }, null, 4)

    fs.writeFileSync(path, configTemplate, { encoding: `utf8`, mode: 0o644, flag: `wx` })
    console.log(`File created in ${path}`)
    process.exit()
} else {
    printHelp(HelpMode.USAGE)
    process.exit()
}

// Read and parse configuration file => config object
fs.readFile(configFilePath, (err, data) => {
    if (err) throw err

    const throwParseError = (name, value, stringType) => {
        throw TypeError(`Found ${name}: ${value}, expected ${stringType} type`)
    }

    console.log(`Validating configuration file ...`)
    const config = JSON.parse(data)

    if (!Number.isInteger(config.port)) {
        throwParseError(`port`, config.port, `integer`)
    }

    if (config.maskedHost && !String.isString(config.maskedHost)) {
        throwParseError(`maskedHost`, config.maskedHost, `string`)
    }

    if (!config.endpoints || config.endpoints.length === 0) {
        throw Error(`No defined endpoints, ${appName} can't capture anything`)
    }

    config.endpoints.forEach(endpoint => {
        if (!String.isString(endpoint.request.path)) {
            throwParseError(`request.path`, endpoint.request.path, `string`)
        }

        if (!String.isString(endpoint.request.method)) {
            throwParseError(`request.method`, endpoint.request.method, `string`)
        }

        // Create regexp to match incoming requests by path conforming
        // RFC 3986: https://www.ietf.org/rfc/rfc3986.txt
        // 2.3.  Unreserved Characters
        //      Characters that are allowed in a URI but do not have a reserved
        //      purpose are called unreserved.  These include uppercase and lowercase
        //      letters, decimal digits, hyphen, period, underscore, and tilde.
        //
        //      unreserved  = ALPHA / DIGIT / "-" / "." / "_" / "~"
        let re = endpoint.request.path
        re = re.replace(/\//g, `\\/`)
        re = re.replace(/{\*}/g, `[\\w-.~]+`)
        re = `^\\/?` + re + `\\/?(\\?|$)`
        endpoint.request.path = {
            name: endpoint.request.path,
            re: new RegExp(re, `i`)
        }

        if (!endpoint.responses || endpoint.responses.length === 0) {
            throw Error(`No response for ${endpoint.request.path.name}, ${appName} can't send anything`)
        }

        endpoint.responses.forEach(response => {
            if (!Number.isInteger(response.statusCode)) {
                throwParseError(`response.statusCode`, response.statusCode, `integer`)
            }

            // Node.js itself defines an invalid HTTP status code as follows, so the same
            // condition will be enforced
            //
            // ERR_HTTP_INVALID_STATUS_CODE
            // Status code was outside the regular status code range (100-999).
            // Ref: https://nodejs.org/dist/latest-v12.x/docs/api/errors.html#errors_err_http_invalid_status_code
            if (response.statusCode < 100 || response.statusCode > 999) {
                throw TypeError(`Invalid status code: ${response.statusCode}`)
            }

            safeForEachHeader(response.headers, header => {
                if (!response.headers[header]) {
                    response.headers[header] = ``
                }
            })
        })

        // Add isActive property (by default true) if missing
        if (endpoint.isActive === undefined) {
            endpoint.isActive = true
        } else if (!Boolean.isBoolean(endpoint.isActive)) {
            throwParseError(`endpoint.isActive`, endpoint.isActive, `boolean`)
        }

        // Add activeResponse property if missing
        if (endpoint.activeResponse === undefined) {
            endpoint.activeResponse = endpoint.responses[0].statusCode
        } else if (!Number.isInteger(endpoint.activeResponse)) {
            throwParseError(`endpoint.activeResponse`, endpoint.activeResponse, `integer`)
        }
    })

    // Create server cli
    const cli = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `> `
    })

    // Start HTTP server
    const server = http.createServer((originalRequest, originalResponse) => {
        const matchHeaders = (endpointHeaders, requestHeaders) => {
            if (endpointHeaders) {
                const expectedHeaders = Object.keys(endpointHeaders).map(header => header.trim())
                for (let i = 0; i < expectedHeaders.length; i++) {
                    const key = expectedHeaders[i]
                    const eh = endpointHeaders[key]
                    const rh = requestHeaders[key.toLowerCase()]

                    if (!((eh && (rh.includes(eh))) || (!eh && rh))) {
                        return false
                    }
                }
            }
            return true
        }

        // Pause the console server
        cli.pause()

        let originalBody = ``
        originalRequest.on(`data`, (chunk) => {
            originalBody = originalBody + chunk
        })

        originalRequest.on(`end`, () => {
            let logAction = ``
            const originalURL = new url.URL(originalRequest.url, `http://${config.maskedHost ? config.maskedHost : `localhost:${config.port}`}`)
            const capturedEndpoint = config.endpoints.find(endpoint => endpoint.request.path.re.test(originalURL.pathname))

            if (capturedEndpoint &&
                capturedEndpoint.isActive &&
                capturedEndpoint.request.method === originalRequest.method &&
                matchHeaders(capturedEndpoint.request.headers, originalRequest.headers)) {
                // Take over the incoming request
                logAction = `Captured`

                const selectedResponse = capturedEndpoint.responses.find(response => response.statusCode === capturedEndpoint.activeResponse)
                let selectedHeaders = {}
                let selectedBody = ``

                if (selectedResponse) {
                    selectedHeaders = selectedResponse.headers ? selectedResponse.headers : {}
                    selectedBody = JSON.stringify(selectedResponse.body ? selectedResponse.body : {})
                }

                originalResponse
                    .writeHead(capturedEndpoint.activeResponse, selectedHeaders)
                    .end(selectedBody)
            } else if (config.maskedHost) {
                // Redirect the incoming request to the "real" server
                logAction = `Passed through`

                const maskedRequest = http.request(
                    originalURL,
                    {
                        method: originalRequest.method,
                        headers: originalRequest.headers
                    },
                    maskedResponse => {
                        let maskedBody = ``
                        maskedResponse.on(`data`, chunk => {
                            maskedBody = maskedBody + chunk
                        })
                        maskedResponse.on(`end`, () => {
                            originalResponse
                                .writeHead(maskedResponse.statusCode, maskedResponse.headers)
                                .end(maskedBody)
                        })
                    }
                )

                maskedRequest.on(`error`, error => {
                    const errorStatusCode = 500
                    originalResponse
                        .writeHead(errorStatusCode, { 'Content-Type': `text/html`, 'User-Agent': `${appName}/${appVersion}` })
                        .end(
                            `<!DOCTYPE html>
                            <html>
                                <head>
                                    <title>${appName} version ${appVersion}</title>
                                </head>
                                <body>
                                    <h1>${errorStatusCode} Internal Server Error</h1>
                                    <p style="font-size:20px">${appName} could not send the request to the masked host</p>
                                    <p style="font-size:20px">reason: ${error.message}</p>
                                </body>
                            </html>`
                        )
                })

                maskedRequest.write(originalBody)
                maskedRequest.end()
            } else {
                // Default response, no masked host or endpoint defined
                logAction = `Ignored`

                originalResponse
                    .writeHead(200, { 'Content-Type': `text/html`, 'User-Agent': `${appName}/${appVersion}` })
                    .end(
                        `<!DOCTYPE html>
                        <html>
                            <head>
                                <title>${appName} version ${appVersion}</title>
                            </head>
                            <body>
                                <h1>${appName} version ${appVersion}</h1>
                                <p style="font-size:20px">${appName} is up and running, if you wanted to capture this URL or if you meant it to reach the masked host, please modify the configuration file accordingly</p>
                            </body>
                        </html>`
                    )
            }

            // Log the incoming requests to standard output and resume the console
            console.log(`${originalRequest.method} ${originalURL.pathname}${originalURL.search} - ${logAction}`)
            cli.resume()
        })
    })

    server.listen(config.port, () => {
        console.log(`Server running at http://localhost:${config.port}${config.maskedHost ? `/ (masking ${config.maskedHost})` : ``}`)
        console.log(`To stop it use Ctrl-C or Ctrl-D\n`)

        // Start server console
        cli.prompt()
        cli.on(`line`, (input) => {
            const regexId = /^\d+$/

            const list = () => {
                // list: List all endpoints
                if (config.maskedHost) {
                    console.log(`Masking ${config.maskedHost}`)
                }

                config.endpoints.forEach((endpoint, index) => {
                    console.log(`${index}: ${endpoint.request.method} ${endpoint.request.path.name}, isActive: ${endpoint.isActive}, activeResponse: ${endpoint.activeResponse}`)
                })
            }

            const info = (id) => {
                // info <id>: Print the endpoint <id> information in readable way
                if (!regexId.test(id)) {
                    console.log(`usage: info <id>`)
                    return
                }

                const endpoint = config.endpoints[id]
                if (!endpoint) {
                    console.log(`There is no endpoint with id: ${id}`)
                    return
                }

                console.log(`Request:\n  ${endpoint.request.method} ${endpoint.request.path.name}, isActive:${endpoint.isActive}, activeResponse: ${endpoint.activeResponse}`)
                safeForEachHeader(endpoint.request.headers, header => {
                    console.log(`  ${header}: ${endpoint.request.headers[header]}`)
                })
                endpoint.responses.forEach(response => {
                    console.log(`Response: ${response.statusCode}`)

                    safeForEachHeader(response.headers, header => {
                        console.log(`  ${header}: ${response.headers[header]}`)
                    })

                    if (response.body) {
                        let bodyString = JSON.stringify(response.body, null, 4)
                        bodyString = bodyString.substring(1, bodyString.length - 1)
                        console.log(`  body: {${bodyString}  }`)
                    }
                })
            }

            const toggle = (id) => {
                // toggle <id>: Enable/Disable <id> endpoint
                if (!regexId.test(id)) {
                    console.log(`usage: toggle <id>`)
                    return
                }

                const endpoint = config.endpoints[id]
                if (!endpoint) {
                    console.log(`There is no endpoint with id: ${id}`)
                    return
                }

                endpoint.isActive = !endpoint.isActive
                console.log(`Endpoint ${id} ${endpoint.isActive ? `enabled` : `disabled`}`)
            }

            const response = (id, HTTPStatusCode) => {
                // response <id> <HTTPStatusCode>: Set endpoint <id> to answer with status code <HTTPStatusCode>
                if (!regexId.test(id) || !/^[1-9]\d{2}$/.test(HTTPStatusCode)) {
                    console.log(`usage: response <id> <HTTPStatusCode>`)
                    return
                }

                const endpoint = config.endpoints[id]
                if (!endpoint) {
                    console.log(`There is no endpoint with id: ${id}`)
                    return
                }

                endpoint.activeResponse = parseInt(HTTPStatusCode, 10)
                console.log(`Response set to: ${endpoint.activeResponse}`)
                const selectedResponse = endpoint.responses.find(response => response.statusCode === endpoint.activeResponse)
                if (!selectedResponse) {
                    console.log(`WARNING: No defined response for status code ${endpoint.activeResponse}, ${appName} will return an empty response`)
                }
            }

            const line = input.trim()
            let match = null
            let spaceAfterCommand = true

            if (/^help$/i.test(line)) {
                printHelp(HelpMode.COMMANDS)
            } else if (/^list$/i.test(line)) {
                list()
            } else if ((match = /^info(|\s+(?<id>.*))$/i.exec(line))) {
                info(match.groups.id)
            } else if ((match = /^toggle(|\s+(?<id>.*))$/i.exec(line))) {
                toggle(match.groups.id)
            } else if ((match = /^response(|\s+(?<id>\S*)(|\s+(?<statusCode>.*)))$/i.exec(line))) {
                response(match.groups.id, match.groups.statusCode)
            } else if (/^\s*$/.test(line)) {
                // nop: just ignore the input and leave a blank line in the prompt
                spaceAfterCommand = false
            } else {
                console.log(`Error: Unknown command: ${line}`)
            }

            if (spaceAfterCommand) {
                console.log(``)
            }
            cli.prompt()
        }).on(`pause`, () => {
            console.log(``)
        }).on(`resume`, () => {
            cli.prompt(true)
        }).on(`close`, () => {
            console.log(`Stopping server ...`)
            server.close(function () {
                console.log(`Done!`)
                process.exit()
            })
        })
    })
})
