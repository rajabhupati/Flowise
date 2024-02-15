import { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils'
import { OpenAIEmbedding } from 'llamaindex'

interface LlmGatewayConfig {
    LlmGatewayApiKey?: string
    LlmGatewayApiUrl?: string

}

class LlmGatewayEmbedding_LlamaIndex_Embeddings implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    credential: INodeParams
    tags: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Llm Gateway Embeddings'
        this.name = 'LlmGatewayEmbeddingsLlamaIndex'
        this.version = 1.0
        this.type = 'LlmGatewayEmbeddings'
        this.icon = 'Azure.svg'
        this.category = 'Embeddings'
        this.description = 'Llm Gateway API embeddings specific for LlamaIndex'
        this.baseClasses = [this.type, 'BaseEmbedding_LlamaIndex', ...getBaseClasses(OpenAIEmbedding)]
        this.tags = ['LlamaIndex']
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['LlmGatewayApi']
        }
        this.inputs = [
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
        const timeout = nodeData.inputs?.timeout as string

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const LlmGatewayApiUrl = getCredentialParam('LlmGatewayApiUrl', credentialData, nodeData)
        const LlmGatewayApiKey = getCredentialParam('LlmGatewayApiKey', credentialData, nodeData)

        const obj: Partial<OpenAIEmbedding> & { llmgateway?: LlmGatewayConfig } = {
            llmgateway: {
                LlmGatewayApiKey: LlmGatewayApiKey,
                LlmGatewayApiUrl: LlmGatewayApiUrl
                
            }
        }

        if (timeout) obj.timeout = parseInt(timeout, 10)

        const model = new OpenAIEmbedding(obj)
        return model
    }
}

module.exports = { nodeClass: LlmGatewayEmbedding_LlamaIndex_Embeddings }
