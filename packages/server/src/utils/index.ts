import path from 'path'
import fs from 'fs'
import logger from './logger'
import {
    IComponentCredentials,
    IComponentNodes,
    ICredentialDataDecrypted,
    ICredentialReqBody,
    IDepthQueue,
    IExploredNode,
    INodeData,
    INodeDependencies,
    INodeDirectedGraph,
    INodeQueue,
    IOverrideConfig,
    IReactFlowEdge,
    IReactFlowNode,
    IVariableDict,
    IncomingInput
} from '../Interface'
import { cloneDeep, get, isEqual } from 'lodash'
import {
    convertChatHistoryToText,
    getInputVariables,
    handleEscapeCharacters,
    getEncryptionKeyPath,
    ICommonObject,
    IDatabaseEntity,
    IMessage,
    FlowiseMemory
} from 'flowise-components'
import { randomBytes } from 'crypto'
import { AES, enc } from 'crypto-js'

import { ChatFlow } from '../database/entities/ChatFlow'
import { ChatMessage } from '../database/entities/ChatMessage'
import { Credential } from '../database/entities/Credential'
import { Tool } from '../database/entities/Tool'
import { Assistant } from '../database/entities/Assistant'
import { DataSource } from 'typeorm'
import { CachePool } from '../CachePool'
import { Variable } from '../database/entities/Variable'

const QUESTION_VAR_PREFIX = 'question'
const CHAT_HISTORY_VAR_PREFIX = 'chat_history'
const REDACTED_CREDENTIAL_VALUE = '_FLOWISE_BLANK_07167752-1a71-43b1-bf8f-4f32252165db'

export const databaseEntities: IDatabaseEntity = {
    ChatFlow: ChatFlow,
    ChatMessage: ChatMessage,
    Tool: Tool,
    Credential: Credential,
    Assistant: Assistant,
    Variable: Variable
}

/**
 * Returns the home folder path of the user if
 * none can be found it falls back to the current
 * working directory
 *
 */
export const getUserHome = (): string => {
    let variableName = 'HOME'
    if (process.platform === 'win32') {
        variableName = 'USERPROFILE'
    }

    if (process.env[variableName] === undefined) {
        // If for some reason the variable does not exist
        // fall back to current folder
        return process.cwd()
    }
    return process.env[variableName] as string
}

/**
 * Returns the path of node modules package
 * @param {string} packageName
 * @returns {string}
 */
export const getNodeModulesPackagePath = (packageName: string): string => {
    const checkPaths = [
        path.join(__dirname, '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', '..', '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', '..', '..', '..', 'node_modules', packageName)
    ]
    for (const checkPath of checkPaths) {
        if (fs.existsSync(checkPath)) {
            return checkPath
        }
    }
    return ''
}

/**
 * Construct graph and node dependencies score
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {IReactFlowEdge[]} reactFlowEdges
 * @param {{ isNonDirected?: boolean, isReversed?: boolean }} options
 */
export const constructGraphs = (
    reactFlowNodes: IReactFlowNode[],
    reactFlowEdges: IReactFlowEdge[],
    options?: { isNonDirected?: boolean; isReversed?: boolean }
) => {
    const nodeDependencies = {} as INodeDependencies
    const graph = {} as INodeDirectedGraph

    for (let i = 0; i < reactFlowNodes.length; i += 1) {
        const nodeId = reactFlowNodes[i].id
        nodeDependencies[nodeId] = 0
        graph[nodeId] = []
    }

    if (options && options.isReversed) {
        for (let i = 0; i < reactFlowEdges.length; i += 1) {
            const source = reactFlowEdges[i].source
            const target = reactFlowEdges[i].target

            if (Object.prototype.hasOwnProperty.call(graph, target)) {
                graph[target].push(source)
            } else {
                graph[target] = [source]
            }

            nodeDependencies[target] += 1
        }

        return { graph, nodeDependencies }
    }

    for (let i = 0; i < reactFlowEdges.length; i += 1) {
        const source = reactFlowEdges[i].source
        const target = reactFlowEdges[i].target

        if (Object.prototype.hasOwnProperty.call(graph, source)) {
            graph[source].push(target)
        } else {
            graph[source] = [target]
        }

        if (options && options.isNonDirected) {
            if (Object.prototype.hasOwnProperty.call(graph, target)) {
                graph[target].push(source)
            } else {
                graph[target] = [source]
            }
        }
        nodeDependencies[target] += 1
    }

    return { graph, nodeDependencies }
}

/**
 * Get starting nodes and check if flow is valid
 * @param {INodeDependencies} graph
 * @param {string} endNodeId
 */
export const getStartingNodes = (graph: INodeDirectedGraph, endNodeId: string) => {
    const visited = new Set<string>()
    const queue: Array<[string, number]> = [[endNodeId, 0]]
    const depthQueue: IDepthQueue = {
        [endNodeId]: 0
    }

    let maxDepth = 0
    let startingNodeIds: string[] = []

    while (queue.length > 0) {
        const [currentNode, depth] = queue.shift()!

        if (visited.has(currentNode)) {
            continue
        }

        visited.add(currentNode)

        if (depth > maxDepth) {
            maxDepth = depth
            startingNodeIds = [currentNode]
        } else if (depth === maxDepth) {
            startingNodeIds.push(currentNode)
        }

        for (const neighbor of graph[currentNode]) {
            if (!visited.has(neighbor)) {
                queue.push([neighbor, depth + 1])
                depthQueue[neighbor] = depth + 1
            }
        }
    }

    const depthQueueReversed: IDepthQueue = {}
    for (const nodeId in depthQueue) {
        if (Object.prototype.hasOwnProperty.call(depthQueue, nodeId)) {
            depthQueueReversed[nodeId] = Math.abs(depthQueue[nodeId] - maxDepth)
        }
    }

    return { startingNodeIds, depthQueue: depthQueueReversed }
}

/**
 * Get all connected nodes from startnode
 * @param {INodeDependencies} graph
 * @param {string} startNodeId
 */
export const getAllConnectedNodes = (graph: INodeDirectedGraph, startNodeId: string) => {
    const visited = new Set<string>()
    const queue: Array<[string]> = [[startNodeId]]

    while (queue.length > 0) {
        const [currentNode] = queue.shift()!

        if (visited.has(currentNode)) {
            continue
        }

        visited.add(currentNode)

        for (const neighbor of graph[currentNode]) {
            if (!visited.has(neighbor)) {
                queue.push([neighbor])
            }
        }
    }

    return [...visited]
}

/**
 * Get ending node and check if flow is valid
 * @param {INodeDependencies} nodeDependencies
 * @param {INodeDirectedGraph} graph
 */
export const getEndingNodes = (nodeDependencies: INodeDependencies, graph: INodeDirectedGraph) => {
    const endingNodeIds: string[] = []
    Object.keys(graph).forEach((nodeId) => {
        if (Object.keys(nodeDependencies).length === 1) {
            endingNodeIds.push(nodeId)
        } else if (!graph[nodeId].length && nodeDependencies[nodeId] > 0) {
            endingNodeIds.push(nodeId)
        }
    })
    return endingNodeIds
}

/**
 * Build langchain from start to end
 * @param {string[]} startingNodeIds
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {INodeDirectedGraph} graph
 * @param {IDepthQueue} depthQueue
 * @param {IComponentNodes} componentNodes
 * @param {string} question
 * @param {string} chatId
 * @param {string} chatflowid
 * @param {DataSource} appDataSource
 * @param {ICommonObject} overrideConfig
 * @param {CachePool} cachePool
 */
export const buildLangchain = async (
    startingNodeIds: string[],
    reactFlowNodes: IReactFlowNode[],
    reactFlowEdges: IReactFlowEdge[],
    graph: INodeDirectedGraph,
    depthQueue: IDepthQueue,
    componentNodes: IComponentNodes,
    question: string,
    chatHistory: IMessage[],
    chatId: string,
    sessionId: string,
    chatflowid: string,
    appDataSource: DataSource,
    overrideConfig?: ICommonObject,
    cachePool?: CachePool,
    isUpsert?: boolean,
    stopNodeId?: string
) => {
    const flowNodes = cloneDeep(reactFlowNodes)

    // Create a Queue and add our initial node in it
    const nodeQueue = [] as INodeQueue[]
    const exploredNode = {} as IExploredNode
    const dynamicVariables = {} as Record<string, unknown>
    let ignoreNodeIds: string[] = []

    // In the case of infinite loop, only max 3 loops will be executed
    const maxLoop = 3

    for (let i = 0; i < startingNodeIds.length; i += 1) {
        nodeQueue.push({ nodeId: startingNodeIds[i], depth: 0 })
        exploredNode[startingNodeIds[i]] = { remainingLoop: maxLoop, lastSeenDepth: 0 }
    }

    while (nodeQueue.length) {
        const { nodeId, depth } = nodeQueue.shift() as INodeQueue

        const reactFlowNode = flowNodes.find((nd) => nd.id === nodeId)
        const nodeIndex = flowNodes.findIndex((nd) => nd.id === nodeId)
        if (!reactFlowNode || reactFlowNode === undefined || nodeIndex < 0) continue

        try {
            const nodeInstanceFilePath = componentNodes[reactFlowNode.data.name].filePath as string
            const nodeModule = await import(nodeInstanceFilePath)
            const newNodeInstance = new nodeModule.nodeClass()

            let flowNodeData = cloneDeep(reactFlowNode.data)
            if (overrideConfig) flowNodeData = replaceInputsWithConfig(flowNodeData, overrideConfig)
            const reactFlowNodeData: INodeData = resolveVariables(flowNodeData, flowNodes, question, chatHistory)

            // TODO: Avoid processing Text Splitter + Doc Loader once Upsert & Load Existing Vector Nodes are deprecated
            if (isUpsert && stopNodeId && nodeId === stopNodeId) {
                logger.debug(`[server]: Upserting ${reactFlowNode.data.label} (${reactFlowNode.data.id})`)
                await newNodeInstance.vectorStoreMethods!['upsert']!.call(newNodeInstance, reactFlowNodeData, {
                    chatId,
                    sessionId,
                    chatflowid,
                    chatHistory,
                    logger,
                    appDataSource,
                    databaseEntities,
                    cachePool,
                    dynamicVariables
                })
                logger.debug(`[server]: Finished upserting ${reactFlowNode.data.label} (${reactFlowNode.data.id})`)
                break
            } else {
                logger.debug(`[server]: Initializing ${reactFlowNode.data.label} (${reactFlowNode.data.id})`)
                let outputResult = await newNodeInstance.init(reactFlowNodeData, question, {
                    chatId,
                    sessionId,
                    chatflowid,
                    chatHistory,
                    logger,
                    appDataSource,
                    databaseEntities,
                    cachePool,
                    dynamicVariables
                })

                // Save dynamic variables
                if (reactFlowNode.data.name === 'setVariable') {
                    const dynamicVars = outputResult?.dynamicVariables ?? {}

                    for (const variableKey in dynamicVars) {
                        dynamicVariables[variableKey] = dynamicVars[variableKey]
                    }

                    outputResult = outputResult?.output
                }

                // Determine which nodes to route next when it comes to ifElse
                if (reactFlowNode.data.name === 'ifElseFunction' && typeof outputResult === 'object') {
                    let sourceHandle = ''
                    if (outputResult.type === true) {
                        sourceHandle = `${nodeId}-output-returnFalse-string|number|boolean|json|array`
                    } else if (outputResult.type === false) {
                        sourceHandle = `${nodeId}-output-returnTrue-string|number|boolean|json|array`
                    }

                    const ifElseEdge = reactFlowEdges.find((edg) => edg.source === nodeId && edg.sourceHandle === sourceHandle)
                    if (ifElseEdge) {
                        const { graph } = constructGraphs(
                            reactFlowNodes,
                            reactFlowEdges.filter((edg) => !(edg.source === nodeId && edg.sourceHandle === sourceHandle)),
                            { isNonDirected: true }
                        )
                        ignoreNodeIds.push(ifElseEdge.target, ...getAllConnectedNodes(graph, ifElseEdge.target))
                        ignoreNodeIds = [...new Set(ignoreNodeIds)]
                    }

                    outputResult = outputResult?.output
                }

                flowNodes[nodeIndex].data.instance = outputResult

                logger.debug(`[server]: Finished initializing ${reactFlowNode.data.label} (${reactFlowNode.data.id})`)
            }
        } catch (e: any) {
            logger.error(e)
            throw new Error(e)
        }

        let neighbourNodeIds = graph[nodeId]
        const nextDepth = depth + 1

        // Find other nodes that are on the same depth level
        const sameDepthNodeIds = Object.keys(depthQueue).filter((key) => depthQueue[key] === nextDepth)

        for (const id of sameDepthNodeIds) {
            if (neighbourNodeIds.includes(id)) continue
            neighbourNodeIds.push(id)
        }

        neighbourNodeIds = neighbourNodeIds.filter((neigh) => !ignoreNodeIds.includes(neigh))

        for (let i = 0; i < neighbourNodeIds.length; i += 1) {
            const neighNodeId = neighbourNodeIds[i]
            if (ignoreNodeIds.includes(neighNodeId)) continue
            // If nodeId has been seen, cycle detected
            if (Object.prototype.hasOwnProperty.call(exploredNode, neighNodeId)) {
                const { remainingLoop, lastSeenDepth } = exploredNode[neighNodeId]

                if (lastSeenDepth === nextDepth) continue

                if (remainingLoop === 0) {
                    break
                }
                const remainingLoopMinusOne = remainingLoop - 1
                exploredNode[neighNodeId] = { remainingLoop: remainingLoopMinusOne, lastSeenDepth: nextDepth }
                nodeQueue.push({ nodeId: neighNodeId, depth: nextDepth })
            } else {
                exploredNode[neighNodeId] = { remainingLoop: maxLoop, lastSeenDepth: nextDepth }
                nodeQueue.push({ nodeId: neighNodeId, depth: nextDepth })
            }
        }

        // Move end node to last
        if (!neighbourNodeIds.length) {
            const index = flowNodes.findIndex((nd) => nd.data.id === nodeId)
            flowNodes.push(flowNodes.splice(index, 1)[0])
        }
    }
    return flowNodes
}

/**
 * Clear session memories
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {IComponentNodes} componentNodes
 * @param {string} chatId
 * @param {DataSource} appDataSource
 * @param {string} sessionId
 * @param {string} memoryType
 * @param {string} isClearFromViewMessageDialog
 */
export const clearSessionMemory = async (
    reactFlowNodes: IReactFlowNode[],
    componentNodes: IComponentNodes,
    chatId: string,
    appDataSource: DataSource,
    sessionId?: string,
    memoryType?: string,
    isClearFromViewMessageDialog?: string
) => {
    for (const node of reactFlowNodes) {
        if (node.data.category !== 'Memory' && node.data.type !== 'OpenAIAssistant') continue

        // Only clear specific session memory from View Message Dialog UI
        if (isClearFromViewMessageDialog && memoryType && node.data.label !== memoryType) continue

        const nodeInstanceFilePath = componentNodes[node.data.name].filePath as string
        const nodeModule = await import(nodeInstanceFilePath)
        const newNodeInstance = new nodeModule.nodeClass()
        const options: ICommonObject = { chatId, appDataSource, databaseEntities, logger }

        // SessionId always take priority first because it is the sessionId used for 3rd party memory node
        if (sessionId && node.data.inputs) {
            if (node.data.type === 'OpenAIAssistant') {
                await newNodeInstance.clearChatMessages(node.data, options, { type: 'threadId', id: sessionId })
            } else {
                node.data.inputs.sessionId = sessionId
                const initializedInstance: FlowiseMemory = await newNodeInstance.init(node.data, '', options)
                await initializedInstance.clearChatMessages(sessionId)
            }
        } else if (chatId && node.data.inputs) {
            if (node.data.type === 'OpenAIAssistant') {
                await newNodeInstance.clearChatMessages(node.data, options, { type: 'chatId', id: chatId })
            } else {
                node.data.inputs.sessionId = chatId
                const initializedInstance: FlowiseMemory = await newNodeInstance.init(node.data, '', options)
                await initializedInstance.clearChatMessages(chatId)
            }
        }
    }
}

/**
 * Get variable value from outputResponses.output
 * @param {string} paramValue
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {string} question
 * @param {boolean} isAcceptVariable
 * @returns {string}
 */
export const getVariableValue = (
    paramValue: string,
    reactFlowNodes: IReactFlowNode[],
    question: string,
    chatHistory: IMessage[],
    isAcceptVariable = false
) => {
    let returnVal = paramValue
    const variableStack = []
    const variableDict = {} as IVariableDict
    let startIdx = 0
    const endIdx = returnVal.length - 1

    while (startIdx < endIdx) {
        const substr = returnVal.substring(startIdx, startIdx + 2)

        // Store the opening double curly bracket
        if (substr === '{{') {
            variableStack.push({ substr, startIdx: startIdx + 2 })
        }

        // Found the complete variable
        if (substr === '}}' && variableStack.length > 0 && variableStack[variableStack.length - 1].substr === '{{') {
            const variableStartIdx = variableStack[variableStack.length - 1].startIdx
            const variableEndIdx = startIdx
            const variableFullPath = returnVal.substring(variableStartIdx, variableEndIdx)

            /**
             * Apply string transformation to convert special chars:
             * FROM: hello i am ben\n\n\thow are you?
             * TO: hello i am benFLOWISE_NEWLINEFLOWISE_NEWLINEFLOWISE_TABhow are you?
             */
            if (isAcceptVariable && variableFullPath === QUESTION_VAR_PREFIX) {
                variableDict[`{{${variableFullPath}}}`] = handleEscapeCharacters(question, false)
            }

            if (isAcceptVariable && variableFullPath === CHAT_HISTORY_VAR_PREFIX) {
                variableDict[`{{${variableFullPath}}}`] = handleEscapeCharacters(convertChatHistoryToText(chatHistory), false)
            }

            // Split by first occurrence of '.' to get just nodeId
            const [variableNodeId, _] = variableFullPath.split('.')
            const executedNode = reactFlowNodes.find((nd) => nd.id === variableNodeId)
            if (executedNode) {
                const variableValue = get(executedNode.data, 'instance')
                if (isAcceptVariable) {
                    variableDict[`{{${variableFullPath}}}`] = variableValue
                } else {
                    returnVal = variableValue
                }
            }
            variableStack.pop()
        }
        startIdx += 1
    }

    if (isAcceptVariable) {
        const variablePaths = Object.keys(variableDict)
        variablePaths.sort() // Sort by length of variable path because longer path could possibly contains nested variable
        variablePaths.forEach((path) => {
            const variableValue = variableDict[path]
            // Replace all occurrence
            if (typeof variableValue === 'object') {
                returnVal = returnVal.split(path).join(JSON.stringify(variableValue).replace(/"/g, '\\"'))
            } else {
                returnVal = returnVal.split(path).join(variableValue)
            }
        })
        return returnVal
    }
    return returnVal
}

/**
 * Loop through each inputs and resolve variable if neccessary
 * @param {INodeData} reactFlowNodeData
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {string} question
 * @returns {INodeData}
 */
export const resolveVariables = (
    reactFlowNodeData: INodeData,
    reactFlowNodes: IReactFlowNode[],
    question: string,
    chatHistory: IMessage[]
): INodeData => {
    let flowNodeData = cloneDeep(reactFlowNodeData)
    const types = 'inputs'

    const getParamValues = (paramsObj: ICommonObject) => {
        for (const key in paramsObj) {
            const paramValue: string = paramsObj[key]
            if (Array.isArray(paramValue)) {
                const resolvedInstances = []
                for (const param of paramValue) {
                    const resolvedInstance = getVariableValue(param, reactFlowNodes, question, chatHistory)
                    resolvedInstances.push(resolvedInstance)
                }
                paramsObj[key] = resolvedInstances
            } else {
                const isAcceptVariable = reactFlowNodeData.inputParams.find((param) => param.name === key)?.acceptVariable ?? false
                const resolvedInstance = getVariableValue(paramValue, reactFlowNodes, question, chatHistory, isAcceptVariable)
                paramsObj[key] = resolvedInstance
            }
        }
    }

    const paramsObj = flowNodeData[types] ?? {}

    getParamValues(paramsObj)

    return flowNodeData
}

/**
 * Loop through each inputs and replace their value with override config values
 * @param {INodeData} flowNodeData
 * @param {ICommonObject} overrideConfig
 * @returns {INodeData}
 */
export const replaceInputsWithConfig = (flowNodeData: INodeData, overrideConfig: ICommonObject) => {
    const types = 'inputs'

    const getParamValues = (inputsObj: ICommonObject) => {
        for (const config in overrideConfig) {
            // If overrideConfig[key] is object
            if (overrideConfig[config] && typeof overrideConfig[config] === 'object') {
                const nodeIds = Object.keys(overrideConfig[config])
                if (nodeIds.includes(flowNodeData.id)) {
                    inputsObj[config] = overrideConfig[config][flowNodeData.id]
                    continue
                } else if (nodeIds.some((nodeId) => nodeId.includes(flowNodeData.name))) {
                    /*
                     * "systemMessagePrompt": {
                     *   "chatPromptTemplate_0": "You are an assistant" <---- continue for loop if current node is chatPromptTemplate_1
                     * }
                     */
                    continue
                }
            }

            let paramValue = overrideConfig[config] ?? inputsObj[config]
            // Check if boolean
            if (paramValue === 'true') paramValue = true
            else if (paramValue === 'false') paramValue = false
            inputsObj[config] = paramValue
        }
    }

    const inputsObj = flowNodeData[types] ?? {}

    getParamValues(inputsObj)

    return flowNodeData
}

/**
 * Rebuild flow if LLMChain has dependency on other chains
 * User Question => Prompt_0 => LLMChain_0 => Prompt-1 => LLMChain_1
 * @param {IReactFlowNode[]} startingNodes
 * @returns {boolean}
 */
export const isStartNodeDependOnInput = (startingNodes: IReactFlowNode[], nodes: IReactFlowNode[]): boolean => {
    for (const node of startingNodes) {
        if (node.data.category === 'Cache') return true
        for (const inputName in node.data.inputs) {
            const inputVariables = getInputVariables(node.data.inputs[inputName])
            if (inputVariables.length > 0) return true
        }
    }
    const whitelistNodeNames = ['vectorStoreToDocument', 'autoGPT', 'chatPromptTemplate', 'promptTemplate'] //If these nodes are found, chatflow cannot be reused
    for (const node of nodes) {
        if (node.data.name === 'chatPromptTemplate' || node.data.name === 'promptTemplate') {
            let promptValues: ICommonObject = {}
            const promptValuesRaw = node.data.inputs?.promptValues
            if (promptValuesRaw) {
                try {
                    promptValues = typeof promptValuesRaw === 'object' ? promptValuesRaw : JSON.parse(promptValuesRaw)
                } catch (exception) {
                    console.error(exception)
                }
            }
            if (getAllValuesFromJson(promptValues).includes(`{{${QUESTION_VAR_PREFIX}}}`)) return true
        } else if (whitelistNodeNames.includes(node.data.name)) return true
    }
    return false
}

/**
 * Rebuild flow if new override config is provided
 * @param {boolean} isInternal
 * @param {ICommonObject} existingOverrideConfig
 * @param {ICommonObject} newOverrideConfig
 * @returns {boolean}
 */
export const isSameOverrideConfig = (
    isInternal: boolean,
    existingOverrideConfig?: ICommonObject,
    newOverrideConfig?: ICommonObject
): boolean => {
    if (isInternal) {
        if (existingOverrideConfig && Object.keys(existingOverrideConfig).length) return false
        return true
    }
    // If existing and new overrideconfig are the same
    if (
        existingOverrideConfig &&
        Object.keys(existingOverrideConfig).length &&
        newOverrideConfig &&
        Object.keys(newOverrideConfig).length &&
        isEqual(existingOverrideConfig, newOverrideConfig)
    ) {
        return true
    }
    // If there is no existing and new overrideconfig
    if (!existingOverrideConfig && !newOverrideConfig) return true
    return false
}

/**
 * Map MimeType to InputField
 * @param {string} mimeType
 * @returns {Promise<string>}
 */
export const mapMimeTypeToInputField = (mimeType: string) => {
    switch (mimeType) {
        case 'text/plain':
            return 'txtFile'
        case 'application/pdf':
            return 'pdfFile'
        case 'application/json':
            return 'jsonFile'
        case 'text/csv':
            return 'csvFile'
        case 'application/json-lines':
        case 'application/jsonl':
        case 'text/jsonl':
            return 'jsonlinesFile'
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return 'docxFile'
        case 'application/vnd.yaml':
        case 'application/x-yaml':
        case 'text/vnd.yaml':
        case 'text/x-yaml':
        case 'text/yaml':
            return 'yamlFile'
        default:
            return ''
    }
}

/**
 * Find all available input params config
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {IComponentCredentials} componentCredentials
 * @returns {IOverrideConfig[]}
 */
export const findAvailableConfigs = (reactFlowNodes: IReactFlowNode[], componentCredentials: IComponentCredentials) => {
    const configs: IOverrideConfig[] = []

    for (const flowNode of reactFlowNodes) {
        for (const inputParam of flowNode.data.inputParams) {
            let obj: IOverrideConfig
            if (inputParam.type === 'file') {
                obj = {
                    node: flowNode.data.label,
                    nodeId: flowNode.data.id,
                    label: inputParam.label,
                    name: 'files',
                    type: inputParam.fileType ?? inputParam.type
                }
            } else if (inputParam.type === 'options') {
                obj = {
                    node: flowNode.data.label,
                    nodeId: flowNode.data.id,
                    label: inputParam.label,
                    name: inputParam.name,
                    type: inputParam.options
                        ? inputParam.options
                              ?.map((option) => {
                                  return option.name
                              })
                              .join(', ')
                        : 'string'
                }
            } else if (inputParam.type === 'credential') {
                // get component credential inputs
                for (const name of inputParam.credentialNames ?? []) {
                    if (Object.prototype.hasOwnProperty.call(componentCredentials, name)) {
                        const inputs = componentCredentials[name]?.inputs ?? []
                        for (const input of inputs) {
                            obj = {
                                node: flowNode.data.label,
                                nodeId: flowNode.data.id,
                                label: input.label,
                                name: input.name,
                                type: input.type === 'password' ? 'string' : input.type
                            }
                            configs.push(obj)
                        }
                    }
                }
                continue
            } else {
                obj = {
                    node: flowNode.data.label,
                    nodeId: flowNode.data.id,
                    label: inputParam.label,
                    name: inputParam.name,
                    type: inputParam.type === 'password' ? 'string' : inputParam.type
                }
            }
            if (!configs.some((config) => JSON.stringify(config) === JSON.stringify(obj))) {
                configs.push(obj)
            }
        }
    }

    return configs
}

/**
 * Check to see if flow valid for stream
 * TODO: perform check from component level. i.e: set streaming on component, and check here
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {INodeData} endingNodeData
 * @returns {boolean}
 */
export const isFlowValidForStream = (reactFlowNodes: IReactFlowNode[], endingNodeData: INodeData) => {
    const streamAvailableLLMs = {
        'Chat Models': [
            'azureChatOpenAI',
            'chatOpenAI',
            'chatOpenAI_LlamaIndex',
            'chatAnthropic',
            'chatAnthropic_LlamaIndex',
            'chatOllama',
            'awsChatBedrock',
            'chatMistralAI',
            'LlmGateway'
        ],
        LLMs: ['azureOpenAI', 'openAI', 'ollama','LlmGateway']
    }

    let isChatOrLLMsExist = false
    for (const flowNode of reactFlowNodes) {
        const data = flowNode.data
        if (data.category === 'Chat Models' || data.category === 'LLMs') {
            isChatOrLLMsExist = true
            const validLLMs = streamAvailableLLMs[data.category]
            if (!validLLMs.includes(data.name)) return false
        }
    }

    let isValidChainOrAgent = false
    if (endingNodeData.category === 'Chains') {
        // Chains that are not available to stream
        const blacklistChains = ['openApiChain', 'vectaraQAChain']
        isValidChainOrAgent = !blacklistChains.includes(endingNodeData.name)
    } else if (endingNodeData.category === 'Agents') {
        // Agent that are available to stream
        const whitelistAgents = ['openAIFunctionAgent', 'csvAgent', 'airtableAgent', 'conversationalRetrievalAgent']
        isValidChainOrAgent = whitelistAgents.includes(endingNodeData.name)
    } else if (endingNodeData.category === 'Engine') {
        const whitelistEngine = ['contextChatEngine', 'simpleChatEngine', 'queryEngine', 'subQuestionQueryEngine']
        isValidChainOrAgent = whitelistEngine.includes(endingNodeData.name)
    }

    // If no output parser, flow is available to stream
    let isOutputParserExist = false
    for (const flowNode of reactFlowNodes) {
        const data = flowNode.data
        if (data.category.includes('Output Parser')) {
            isOutputParserExist = true
        }
    }

    return isChatOrLLMsExist && isValidChainOrAgent && !isOutputParserExist
}

/**
 * Generate an encryption key
 * @returns {string}
 */
export const generateEncryptKey = (): string => {
    return randomBytes(24).toString('base64')
}

/**
 * Returns the encryption key
 * @returns {Promise<string>}
 */
export const getEncryptionKey = async (): Promise<string> => {
    if (process.env.FLOWISE_SECRETKEY_OVERWRITE !== undefined && process.env.FLOWISE_SECRETKEY_OVERWRITE !== '') {
        return process.env.FLOWISE_SECRETKEY_OVERWRITE
    }
    try {
        return await fs.promises.readFile(getEncryptionKeyPath(), 'utf8')
    } catch (error) {
        const encryptKey = generateEncryptKey()
        const defaultLocation = process.env.SECRETKEY_PATH
            ? path.join(process.env.SECRETKEY_PATH, 'encryption.key')
            : path.join(getUserHome(), '.flowise', 'encryption.key')
        await fs.promises.writeFile(defaultLocation, encryptKey)
        return encryptKey
    }
}

/**
 * Encrypt credential data
 * @param {ICredentialDataDecrypted} plainDataObj
 * @returns {Promise<string>}
 */
export const encryptCredentialData = async (plainDataObj: ICredentialDataDecrypted): Promise<string> => {
    const encryptKey = await getEncryptionKey()
    return AES.encrypt(JSON.stringify(plainDataObj), encryptKey).toString()
}

/**
 * Decrypt credential data
 * @param {string} encryptedData
 * @param {string} componentCredentialName
 * @param {IComponentCredentials} componentCredentials
 * @returns {Promise<ICredentialDataDecrypted>}
 */
export const decryptCredentialData = async (
    encryptedData: string,
    componentCredentialName?: string,
    componentCredentials?: IComponentCredentials
): Promise<ICredentialDataDecrypted> => {
    const encryptKey = await getEncryptionKey()
    const decryptedData = AES.decrypt(encryptedData, encryptKey)
    const decryptedDataStr = decryptedData.toString(enc.Utf8)
    if (!decryptedDataStr) return {}
    try {
        if (componentCredentialName && componentCredentials) {
            const plainDataObj = JSON.parse(decryptedData.toString(enc.Utf8))
            return redactCredentialWithPasswordType(componentCredentialName, plainDataObj, componentCredentials)
        }
        return JSON.parse(decryptedData.toString(enc.Utf8))
    } catch (e) {
        console.error(e)
        return {}
    }
}

/**
 * Transform ICredentialBody from req to Credential entity
 * @param {ICredentialReqBody} body
 * @returns {Credential}
 */
export const transformToCredentialEntity = async (body: ICredentialReqBody): Promise<Credential> => {
    const credentialBody: ICommonObject = {
        name: body.name,
        credentialName: body.credentialName
    }

    if (body.plainDataObj) {
        const encryptedData = await encryptCredentialData(body.plainDataObj)
        credentialBody.encryptedData = encryptedData
    }

    const newCredential = new Credential()
    Object.assign(newCredential, credentialBody)

    return newCredential
}

/**
 * Redact values that are of password type to avoid sending back to client
 * @param {string} componentCredentialName
 * @param {ICredentialDataDecrypted} decryptedCredentialObj
 * @param {IComponentCredentials} componentCredentials
 * @returns {ICredentialDataDecrypted}
 */
export const redactCredentialWithPasswordType = (
    componentCredentialName: string,
    decryptedCredentialObj: ICredentialDataDecrypted,
    componentCredentials: IComponentCredentials
): ICredentialDataDecrypted => {
    const plainDataObj = cloneDeep(decryptedCredentialObj)
    for (const cred in plainDataObj) {
        const inputParam = componentCredentials[componentCredentialName].inputs?.find((inp) => inp.type === 'password' && inp.name === cred)
        if (inputParam) {
            plainDataObj[cred] = REDACTED_CREDENTIAL_VALUE
        }
    }
    return plainDataObj
}

/**
 * Get sessionId
 * Hierarchy of sessionId (top down)
 * API/Embed:
 * (1) Provided in API body - incomingInput.overrideConfig: { sessionId: 'abc' }
 * (2) Provided in API body - incomingInput.chatId
 *
 * API/Embed + UI:
 * (3) Hard-coded sessionId in UI
 * (4) Not specified on UI nor API, default to chatId
 * @param {any} instance
 * @param {IncomingInput} incomingInput
 * @param {string} chatId
 */
export const getMemorySessionId = (
    memoryNode: IReactFlowNode,
    incomingInput: IncomingInput,
    chatId: string,
    isInternal: boolean
): string | undefined => {
    if (!isInternal) {
        // Provided in API body - incomingInput.overrideConfig: { sessionId: 'abc' }
        if (incomingInput.overrideConfig?.sessionId) {
            return incomingInput.overrideConfig?.sessionId
        }
        // Provided in API body - incomingInput.chatId
        if (incomingInput.chatId) {
            return incomingInput.chatId
        }
    }

    // Hard-coded sessionId in UI
    if (memoryNode.data.inputs?.sessionId) {
        return memoryNode.data.inputs.sessionId
    }

    // Default chatId
    return chatId
}

/**
 * Replace chatHistory if incomingInput.history is empty and sessionId/chatId is provided
 * @param {IReactFlowNode} memoryNode
 * @param {IncomingInput} incomingInput
 * @param {DataSource} appDataSource
 * @param {IDatabaseEntity} databaseEntities
 * @param {any} logger
 * @returns {string}
 */
export const getSessionChatHistory = async (
    memoryNode: IReactFlowNode,
    componentNodes: IComponentNodes,
    incomingInput: IncomingInput,
    appDataSource: DataSource,
    databaseEntities: IDatabaseEntity,
    logger: any
): Promise<IMessage[]> => {
    const nodeInstanceFilePath = componentNodes[memoryNode.data.name].filePath as string
    const nodeModule = await import(nodeInstanceFilePath)
    const newNodeInstance = new nodeModule.nodeClass()

    // Replace memory's sessionId/chatId
    if (incomingInput.overrideConfig?.sessionId && memoryNode.data.inputs) {
        memoryNode.data.inputs.sessionId = incomingInput.overrideConfig.sessionId
    } else if (incomingInput.chatId && memoryNode.data.inputs) {
        memoryNode.data.inputs.sessionId = incomingInput.chatId
    }

    const initializedInstance: FlowiseMemory = await newNodeInstance.init(memoryNode.data, '', {
        appDataSource,
        databaseEntities,
        logger
    })

    return (await initializedInstance.getChatMessages()) as IMessage[]
}

/**
 * Method that find memory that is connected within chatflow
 * In a chatflow, there should only be 1 memory node
 * @param {IReactFlowNode[]} nodes
 * @param {IReactFlowEdge[]} edges
 * @returns {string | undefined}
 */
export const findMemoryNode = (nodes: IReactFlowNode[], edges: IReactFlowEdge[]): IReactFlowNode | undefined => {
    const memoryNodes = nodes.filter((node) => node.data.category === 'Memory')
    const memoryNodeIds = memoryNodes.map((mem) => mem.data.id)

    for (const edge of edges) {
        if (memoryNodeIds.includes(edge.source)) {
            const memoryNode = nodes.find((node) => node.data.id === edge.source)
            return memoryNode
        }
    }
    return undefined
}

/**
 * Get all values from a JSON object
 * @param {any} obj
 * @returns {any[]}
 */
export const getAllValuesFromJson = (obj: any): any[] => {
    const values: any[] = []

    function extractValues(data: any) {
        if (typeof data === 'object' && data !== null) {
            if (Array.isArray(data)) {
                for (const item of data) {
                    extractValues(item)
                }
            } else {
                for (const key in data) {
                    extractValues(data[key])
                }
            }
        } else {
            values.push(data)
        }
    }

    extractValues(obj)
    return values
}

/**
 * Get only essential flow data items for telemetry
 * @param {IReactFlowNode[]} nodes
 * @param {IReactFlowEdge[]} edges
 */
export const getTelemetryFlowObj = (nodes: IReactFlowNode[], edges: IReactFlowEdge[]) => {
    const nodeData = nodes.map((node) => node.id)
    const edgeData = edges.map((edge) => ({ source: edge.source, target: edge.target }))
    return { nodes: nodeData, edges: edgeData }
}

/**
 * Get user settings file
 * TODO: move env variables to settings json file, easier configuration
 */
export const getUserSettingsFilePath = () => {
    if (process.env.SECRETKEY_PATH) return path.join(process.env.SECRETKEY_PATH, 'settings.json')
    const checkPaths = [path.join(getUserHome(), '.flowise', 'settings.json')]
    for (const checkPath of checkPaths) {
        if (fs.existsSync(checkPath)) {
            return checkPath
        }
    }
    return ''
}

/**
 * Get app current version
 */
export const getAppVersion = async () => {
    const getPackageJsonPath = (): string => {
        const checkPaths = [
            path.join(__dirname, '..', 'package.json'),
            path.join(__dirname, '..', '..', 'package.json'),
            path.join(__dirname, '..', '..', '..', 'package.json'),
            path.join(__dirname, '..', '..', '..', '..', 'package.json'),
            path.join(__dirname, '..', '..', '..', '..', '..', 'package.json')
        ]
        for (const checkPath of checkPaths) {
            if (fs.existsSync(checkPath)) {
                return checkPath
            }
        }
        return ''
    }

    const packagejsonPath = getPackageJsonPath()
    if (!packagejsonPath) return ''
    try {
        const content = await fs.promises.readFile(packagejsonPath, 'utf8')
        const parsedContent = JSON.parse(content)
        return parsedContent.version
    } catch (error) {
        return ''
    }
}
