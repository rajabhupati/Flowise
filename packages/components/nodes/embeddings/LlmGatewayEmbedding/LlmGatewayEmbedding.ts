import { AzureOpenAIInput } from 'langchain/chat_models/openai'
import { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils'
import { OpenAIEmbeddings, OpenAIEmbeddingsParams } from 'langchain/embeddings/openai'

class LlmGatewayEmbedding_Embeddings implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Llm Gateway Embeddings'
        this.name = 'llmGatewayEmbeddings'
        this.version = 1.0
        this.type = 'LlmGatewayEmbeddings'
        this.icon = 'Azure.svg'
        this.category = 'Embeddings'
        this.description = 'Azure OpenAI API to generate embeddings for a given text'
        this.baseClasses = [this.type, ...getBaseClasses(OpenAIEmbeddings)]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['LlmGatewayApi']
        }
        this.inputs = [
            {
                label: 'Batch Size',
                name: 'batchSize',
                type: 'number',
                default: '100',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Timeout',
                name: 'timeout',
                type: 'number',
                optional: true,
                additionalParams: true
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const batchSize = nodeData.inputs?.batchSize as string
        const timeout = nodeData.inputs?.timeout as string

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const LlmGatewayApiKey = getCredentialParam('LlmGatewayApiKey', credentialData, nodeData)
        const LlmGatewayApiUrl = getCredentialParam('LlmGatewayApiUrl', credentialData, nodeData)
      

        const obj: Partial<OpenAIEmbeddingsParams> & Partial<AzureOpenAIInput> & { llmgateway?: any } = {
            llmgateway: {
                LlmGatewayApiKey,
                LlmGatewayApiUrl
            }
        }

        if (batchSize) obj.batchSize = parseInt(batchSize, 10)
        if (timeout) obj.timeout = parseInt(timeout, 10)

        const model = new OpenAIEmbeddings(obj)
        return model
    }
}

module.exports = { nodeClass: LlmGatewayEmbedding_Embeddings }
