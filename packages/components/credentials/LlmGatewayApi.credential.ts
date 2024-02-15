import { INodeParams, INodeCredential } from '../src/Interface'

class LlmGatewayApi implements INodeCredential {
    label: string
    name: string
    version: number
    description: string
    inputs: INodeParams[]

    constructor() {
        this.label = 'Llm Gateway API'
        this.name = 'llmGatewayApi'
        this.version = 1.0
        this.description =
            'Refer to <a target="_blank" href="https://azure.microsoft.com/en-us/products/cognitive-services/openai-service">official guide</a> of how to use Llm Gateway service'
        this.inputs = [
            {
                label: 'Llm Gateway Api Key',
                name: 'LlmGatewayApiKey',
                type: 'password',
                description: `Refer to <a target="_blank" href="https://etwiki.sys.comcast.net/display/MALG/AppliedAI+LLM+Gateway`
            },
            {
                label: 'Llm Gateway Api Url',
                name: 'LlmGatewayApiUrl',
                type: 'string',
                placeholder: 'Llm Gateway Url'
            }
        ]
    }
}

module.exports = { credClass: LlmGatewayApi }
