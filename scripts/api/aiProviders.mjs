/**
 * AI Provider Registry & Preset Catalog
 * 整合全球主流与国内大语言模型服务商标准配置
 * 统一 OpenAI 兼容协议标准端点
 */

export const AI_PROVIDERS = {
    // ==========================================
    // 🌐 国际服务商 (Global)
    // ==========================================
    gemini: {
        id: 'gemini',
        name: 'Google Gemini',
        category: 'global',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        defaultModel: 'gemini-2.5-flash',
        recommendedModels: [
            'gemini-2.5-flash',
            'gemini-flash-latest',
            'gemini-2.5-flash-lite',
            'gemini-1.5-pro'
        ],
        keyPlaceholder: 'AIzaSy••••••••',
        docsUrl: 'https://aistudio.google.com/app/apikey',
        description: 'Google 官方 OpenAI 兼容协议端点'
    },
    openai: {
        id: 'openai',
        name: 'OpenAI',
        category: 'global',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        recommendedModels: [
            'gpt-4o-mini',
            'gpt-4o',
            'o3-mini',
            'gpt-4.1-mini',
            'gpt-3.5-turbo'
        ],
        keyPlaceholder: 'sk-proj-••••••••',
        docsUrl: 'https://platform.openai.com/api-keys',
        description: 'OpenAI 官方 API 端点'
    },
    openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        category: 'global',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'google/gemini-2.5-flash',
        recommendedModels: [
            'google/gemini-2.5-flash',
            'openai/gpt-4o-mini',
            'anthropic/claude-3.5-haiku',
            'deepseek/deepseek-chat',
            'meta-llama/llama-3.3-70b-instruct',
            'openai/gpt-4o',
            'anthropic/claude-3.5-sonnet',
            'qwen/qwen-2.5-72b-instruct'
        ],
        keyPlaceholder: 'sk-or-v1-••••••••',
        docsUrl: 'https://openrouter.ai/keys',
        description: 'OpenRouter 多模型路由网关'
    },
    groq: {
        id: 'groq',
        name: 'Groq',
        category: 'global',
        baseUrl: 'https://api.groq.com/openai/v1',
        defaultModel: 'llama-3.3-70b-versatile',
        recommendedModels: [
            'llama-3.3-70b-versatile',
            'llama-3.1-8b-instant',
            'mixtral-8x7b-32768',
            'gemma2-9b-it'
        ],
        keyPlaceholder: 'gsk_••••••••',
        docsUrl: 'https://console.groq.com/keys',
        description: 'Groq 官方推理引擎端点'
    },
    mistral: {
        id: 'mistral',
        name: 'Mistral AI',
        category: 'global',
        baseUrl: 'https://api.mistral.ai/v1',
        defaultModel: 'mistral-small-latest',
        recommendedModels: [
            'mistral-small-latest',
            'mistral-large-latest',
            'codestral-latest'
        ],
        keyPlaceholder: '••••••••',
        docsUrl: 'https://console.mistral.ai/api-keys/',
        description: 'Mistral AI 官方 API 端点'
    },
    perplexity: {
        id: 'perplexity',
        name: 'Perplexity AI',
        category: 'global',
        baseUrl: 'https://api.perplexity.ai',
        defaultModel: 'sonar',
        recommendedModels: [
            'sonar',
            'sonar-pro',
            'sonar-reasoning'
        ],
        keyPlaceholder: 'pplx-••••••••',
        docsUrl: 'https://www.perplexity.ai/settings/api',
        description: 'Perplexity 官方 API 端点'
    },
    together: {
        id: 'together',
        name: 'Together AI',
        category: 'global',
        baseUrl: 'https://api.together.xyz/v1',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        recommendedModels: [
            'meta-llama/Llama-3.3-70B-Instruct-Turbo',
            'deepseek-ai/DeepSeek-V3',
            'Qwen/Qwen2.5-72B-Instruct-Turbo'
        ],
        keyPlaceholder: '••••••••',
        docsUrl: 'https://api.together.xyz/settings/api-keys',
        description: 'Together AI 官方 API 端点'
    },
    github_models: {
        id: 'github_models',
        name: 'GitHub Models',
        category: 'global',
        baseUrl: 'https://models.inference.ai.azure.com',
        defaultModel: 'gpt-4o-mini',
        recommendedModels: [
            'gpt-4o-mini',
            'gpt-4o',
            'Meta-Llama-3.1-70B-Instruct'
        ],
        keyPlaceholder: 'ghp_••••••••',
        docsUrl: 'https://github.com/marketplace/models',
        description: 'GitHub Models 官方推理端点'
    },
    xai: {
        id: 'xai',
        name: 'xAI (Grok)',
        category: 'global',
        baseUrl: 'https://api.x.ai/v1',
        defaultModel: 'grok-2-latest',
        recommendedModels: [
            'grok-2-latest',
            'grok-beta'
        ],
        keyPlaceholder: 'xai-••••••••',
        docsUrl: 'https://console.x.ai/',
        description: 'xAI Grok 官方 API 端点'
    },

    // ==========================================
    // 🇨🇳 国内服务商 (China)
    // ==========================================
    deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        category: 'china',
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
        recommendedModels: [
            'deepseek-chat',
            'deepseek-reasoner'
        ],
        keyPlaceholder: 'sk-••••••••',
        docsUrl: 'https://platform.deepseek.com/api_keys',
        description: 'DeepSeek 官方 API 端点'
    },
    siliconflow: {
        id: 'siliconflow',
        name: '硅基流动 (SiliconFlow)',
        category: 'china',
        baseUrl: 'https://api.siliconflow.cn/v1',
        defaultModel: 'deepseek-ai/DeepSeek-V3',
        recommendedModels: [
            'deepseek-ai/DeepSeek-V3',
            'deepseek-ai/DeepSeek-R1',
            'Qwen/Qwen2.5-7B-Instruct',
            'THUDM/glm-4-9b-chat'
        ],
        keyPlaceholder: 'sk-••••••••',
        docsUrl: 'https://cloud.siliconflow.cn/account/ak',
        description: '硅基流动官方 API 端点'
    },
    dashscope: {
        id: 'dashscope',
        name: '阿里云通义千问',
        category: 'china',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultModel: 'qwen-plus',
        recommendedModels: [
            'qwen-plus',
            'qwen-turbo',
            'qwen-max',
            'deepseek-v3'
        ],
        keyPlaceholder: 'sk-••••••••',
        docsUrl: 'https://dashscope.console.aliyun.com/apiKey',
        description: '阿里云通义千问官方兼容端点'
    },
    zhipu: {
        id: 'zhipu',
        name: '智谱清言 (GLM)',
        category: 'china',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModel: 'glm-4-flash',
        recommendedModels: [
            'glm-4-flash',
            'glm-4-plus',
            'glm-4-air'
        ],
        keyPlaceholder: '••••••••',
        docsUrl: 'https://bigmodel.cn/usercenter/apikeys',
        description: '智谱 AI 官方 API 端点'
    },
    moonshot: {
        id: 'moonshot',
        name: '月之暗面 (Kimi)',
        category: 'china',
        baseUrl: 'https://api.moonshot.cn/v1',
        defaultModel: 'moonshot-v1-8k',
        recommendedModels: [
            'moonshot-v1-8k',
            'moonshot-v1-32k'
        ],
        keyPlaceholder: 'sk-••••••••',
        docsUrl: 'https://platform.moonshot.cn/console/api-keys',
        description: '月之暗面官方 API 端点'
    },
    lingyi: {
        id: 'lingyi',
        name: '零一万物',
        category: 'china',
        baseUrl: 'https://api.lingyiwanwu.com/v1',
        defaultModel: 'yi-lightning',
        recommendedModels: [
            'yi-lightning',
            'yi-large'
        ],
        keyPlaceholder: 'sk-••••••••',
        docsUrl: 'https://platform.lingyiwanwu.com/apikeys',
        description: '零一万物官方 API 端点'
    },
    baichuan: {
        id: 'baichuan',
        name: '百川智能',
        category: 'china',
        baseUrl: 'https://api.baichuan-ai.com/v1',
        defaultModel: 'Baichuan4',
        recommendedModels: [
            'Baichuan4',
            'Baichuan3-Turbo'
        ],
        keyPlaceholder: 'sk-••••••••',
        docsUrl: 'https://platform.baichuan-ai.com/console/apikey',
        description: '百川智能官方 API 端点'
    },

    // ==========================================
    // 💻 本地与通用网关 (Local & Gateways)
    // ==========================================
    ollama: {
        id: 'ollama',
        name: 'Ollama (本地)',
        category: 'gateway',
        baseUrl: 'http://localhost:11434/v1',
        defaultModel: 'qwen2.5',
        recommendedModels: [
            'qwen2.5',
            'llama3.2',
            'deepseek-r1:1.5b',
            'mistral'
        ],
        keyPlaceholder: 'ollama (可留空或输入任意值)',
        docsUrl: 'https://ollama.com/',
        description: '本地离线运行的开源大模型 (localhost:11434)'
    },
    lmstudio: {
        id: 'lmstudio',
        name: 'LM Studio (本地)',
        category: 'gateway',
        baseUrl: 'http://localhost:1234/v1',
        defaultModel: 'local-model',
        recommendedModels: [
            'local-model'
        ],
        keyPlaceholder: 'lm-studio (可留空)',
        docsUrl: 'https://lmstudio.ai/',
        description: '本地图形化大模型运行平台 (localhost:1234)'
    },
    azure: {
        id: 'azure',
        name: 'Azure OpenAI',
        category: 'gateway',
        baseUrl: 'https://YOUR_RESOURCE_NAME.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT',
        defaultModel: 'gpt-4o-mini',
        recommendedModels: [
            'gpt-4o-mini',
            'gpt-4o'
        ],
        keyPlaceholder: '••••••••',
        docsUrl: 'https://portal.azure.com/',
        description: '微软云 Azure OpenAI 部署端点'
    },
    custom: {
        id: 'custom',
        name: '自定义 / OneAPI',
        category: 'gateway',
        baseUrl: '',
        defaultModel: '',
        recommendedModels: [],
        keyPlaceholder: 'sk-••••••••',
        docsUrl: '',
        description: '兼容 OpenAI 格式的第三方聚合站或私有中转'
    }
}

/**
 * 获取分类组织的服务商列表，用于前端渲染 Optgroup 和胶囊预设
 */
export function getCategorizedProviders() {
    const list = Object.values(AI_PROVIDERS)
    return {
        global: list.filter(p => p.category === 'global'),
        china: list.filter(p => p.category === 'china'),
        gateway: list.filter(p => p.category === 'gateway')
    }
}
