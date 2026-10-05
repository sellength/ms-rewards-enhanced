import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const htmlPath = path.join(__dirname, '../../public/index.html')
const htmlSource = fs.readFileSync(htmlPath, 'utf8')

function extractFunctionSource(source, funcName) {
    const pattern = new RegExp(`function\\s+${funcName}\\s*\\(`)
    const match = source.match(pattern)
    if (!match || match.index === undefined) {
        throw new Error(`Could not find function ${funcName} in source`)
    }
    const startIdx = match.index
    const braceStart = source.indexOf('{', startIdx)
    if (braceStart === -1) {
        throw new Error(`Could not find opening brace for function ${funcName}`)
    }
    let depth = 1
    let i = braceStart + 1
    while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++
        else if (source[i] === '}') depth--
        i++
    }
    if (depth !== 0) {
        throw new Error(`Unmatched braces for function ${funcName}`)
    }
    return source.slice(startIdx, i)
}

function createLoadedSandbox() {
    const sandbox = {
        window: { location: { origin: 'http://localhost:8080' } },
        URL,
        Array,
        String
    }
    vm.createContext(sandbox)
    vm.runInContext(extractFunctionSource(htmlSource, 'escapeHtml'), sandbox)
    vm.runInContext(extractFunctionSource(htmlSource, 'sanitizeImageUrl'), sandbox)
    vm.runInContext(extractFunctionSource(htmlSource, 'sanitizeUrl'), sandbox)
    return sandbox
}

test('XSS Defense: escapeHtml extracted from public/index.html converts all HTML control characters to safe entities', () => {
    const sandbox = createLoadedSandbox()
    const { escapeHtml } = sandbox

    const payload1 = '<script>alert("xss")</script>'
    const escaped1 = escapeHtml(payload1)
    assert.equal(escaped1, '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
    assert.doesNotMatch(escaped1, /<script>/)

    const payload2 = '"><img src=x onerror=alert(1)>'
    const escaped2 = escapeHtml(payload2)
    assert.equal(escaped2, '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
    assert.doesNotMatch(escaped2, /<img/)

    const payload3 = "'; alert('attack'); //"
    const escaped3 = escapeHtml(payload3)
    assert.equal(escaped3, '&#39;; alert(&#39;attack&#39;); //')
})

test('XSS Defense: sanitizeImageUrl extracted from public/index.html rejects javascript pseudo-protocol, attribute injection and non-image data URIs', () => {
    const sandbox = createLoadedSandbox()
    const { sanitizeImageUrl } = sandbox

    // 1. 拦截 javascript: 伪协议
    assert.equal(sanitizeImageUrl('javascript:alert(document.cookie)'), '')
    assert.equal(sanitizeImageUrl('JAVASCRIPT:/*foo*/alert(1)'), '')

    // 2. 拦截 vbscript: 与 data:text/html
    assert.equal(sanitizeImageUrl('vbscript:msgbox(1)'), '')
    assert.equal(sanitizeImageUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='), '')

    // 3. 拦截属性闭合注入
    assert.equal(sanitizeImageUrl('https://example.com/logo.png" onerror="alert(1)'), '')

    // 4. 放行合法远程 HTTPS/HTTP 图片
    assert.equal(
        sanitizeImageUrl('https://assets.bing.com/rewards/card-icon.png'),
        'https://assets.bing.com/rewards/card-icon.png'
    )

    // 5. 放行合法安全的 base64 图片
    const safeDataImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    assert.equal(sanitizeImageUrl(safeDataImage), safeDataImage)
})

test('XSS Defense: sanitizeUrl extracted from public/index.html blocks dangerous schemes and fallbacks to #', () => {
    const sandbox = createLoadedSandbox()
    const { sanitizeUrl } = sandbox

    assert.equal(sanitizeUrl('javascript:alert(1)'), '#')
    assert.equal(sanitizeUrl('data:text/html,<script>alert(1)</script>'), '#')
    assert.equal(sanitizeUrl('https://rewards.bing.com/dashboard'), 'https://rewards.bing.com/dashboard')
})

test('XSS Defense: public/index.html source verifies that log append does not use raw text in innerHTML', () => {
    const html = htmlSource

    // 验证 appendDesktopLog 与 appendMobileLog 不再把 raw text 拼接到 innerHTML
    assert.doesNotMatch(html, /appendDesktopLog[^{]*\{[^}]*row\.innerHTML\s*=\s*`[^`]*\$\{text\}/)
    assert.doesNotMatch(html, /appendMobileLog[^{]*\{[^}]*row\.innerHTML\s*=\s*`[^`]*\$\{text\}/)
    assert.match(html, /msg\.textContent\s*=\s*String\(text\)/)
})

test('XSS Defense: public/index.html source verifies Punch Card and Explore Card use sanitizeUrl for destination links', () => {
    const html = htmlSource

    // 验证 Punch Card 和 探索卡均使用 sanitizeUrl
    assert.match(html, /sanitizeUrl\(card\.destinationUrl\)/)
    assert.match(html, /sanitizeUrl\(item\.destinationUrl\)/)
    // 验证没有任何未清洗的 item.destinationUrl 或 card.destinationUrl 直接作为 href 属性值
    assert.doesNotMatch(html, /href=["']\$\{item\.destinationUrl\}["']/)
    assert.doesNotMatch(html, /href=["']\$\{card\.destinationUrl\}["']/)
})

test('XSS Defense: public/index.html source verifies Profile buttons avoid inline onclick code injection', () => {
    const html = htmlSource

    // 验证不存在内联拼接 id 的 onclick
    assert.doesNotMatch(html, /onclick=["']switchActiveProfile\(/)
    assert.doesNotMatch(html, /onclick=["'][^"']*switchActiveProfile\(\$\{/)
    // 验证采用 data-action 与 data-id 安全属性
    assert.match(html, /data-action="switch"/)
    assert.match(html, /data-id="\$\{escapeHtml\(p\.id\)\}"/)
})

test('XSS Defense: public/index.html source verifies Explore Flyout drawer sanitizes destinationUrl before innerHTML', () => {
    const html = htmlSource

    // 验证探索抽屉严格使用 sanitizeUrl 清洗 destinationUrl
    assert.match(html, /const\s+safeDest\s*=\s*sanitizeUrl\(rawDest\)/)
    assert.match(html, /href="\$\{safeDest\}"/)
    // 验证绝不将未经 sanitizeUrl 的 card.destinationUrl 直接拼入 a 标签 href
    assert.doesNotMatch(html, /<a\s+href="\$\{card\.destinationUrl[^}]*\}"/)
})

test('XSS Defense: Explore drawer rendering using extracted sanitizers blocks malicious destinationUrl payloads', () => {
    const sandbox = createLoadedSandbox()
    const { escapeHtml, sanitizeUrl } = sandbox

    // 模拟恶意卡片数据
    const maliciousCards = [
        { title: 'Test 1', destinationUrl: 'javascript:alert(document.cookie)' },
        { title: 'Test 2', destinationUrl: 'https://bing.com/search" onfocus="alert(1)' },
        { title: '<script>alert("xss")</script>', destinationUrl: '"><img src=x onerror=alert(1)>' }
    ];

    maliciousCards.forEach(card => {
        const rawDest = card.destinationUrl ? (card.destinationUrl.startsWith('http') ? card.destinationUrl : 'https://www.bing.com' + card.destinationUrl) : '';
        const safeDest = sanitizeUrl(rawDest);
        const linkHtml = rawDest && safeDest !== '#'
            ? `<a href="${safeDest}" target="_blank" rel="noopener noreferrer" class="flyout-link-btn">去搜索 ↗</a>`
            : '';

        const rendered = `
            <div class="flyout-subtask-title">${escapeHtml(card.title || '探索任务')}</div>
            <div class="flyout-subtask-foot">${linkHtml}</div>
        `;

        // 验证生成的 HTML 绝对不含有未转义的 <script>、javascript:、onerror、onfocus
        assert.doesNotMatch(rendered, /<script>/i)
        assert.doesNotMatch(rendered, /href="javascript:/i)
        assert.doesNotMatch(rendered, /onerror=/i)
        assert.doesNotMatch(rendered, /onfocus=/i)
        assert.doesNotMatch(rendered, /onmouseover=/i)
    });
})

test('XSS Defense: public/index.html source verifies external AI models use safe DOM API instead of innerHTML', () => {
    const html = htmlSource

    // 验证必须定义了 populateModelDatalist
    assert.match(html, /function\s+populateModelDatalist\s*\(/)
    // 验证 external models 与 recommended models 使用 populateModelDatalist
    assert.match(html, /populateModelDatalist\(['"]aiModelDatalist['"],\s*data\.models\)/)
    assert.match(html, /populateModelDatalist\(['"]aiModelDatalist['"],\s*preset\.recommendedModels\)/)
    // 验证不存在向 aiModelDatalist 拼接 innerHTML 的危险 sink
    assert.doesNotMatch(html, /aiModelDatalist[^}]*innerHTML\s*=\s*data\.models/)
    assert.doesNotMatch(html, /aiModelDatalist[^}]*innerHTML\s*=\s*preset\.recommendedModels/)
})

test('XSS Defense: populateModelDatalist extracted from public/index.html executes in controlled DOM and blocks HTML/event injection', () => {
    // 1. 精确提取 public/index.html 中的真实 populateModelDatalist 函数源码
    const fnCode = extractFunctionSource(htmlSource, 'populateModelDatalist')
    assert.ok(fnCode, '必须能从 public/index.html 中提取到 populateModelDatalist 真实源码')

    // 2. 构建符合 W3C DOM Level 2 规范的受控 DOM 沙箱
    class ControlledDOMNode {
        constructor(tagName) {
            this.tagName = String(tagName).toUpperCase()
            this.childNodes = []
            this.attributes = Object.create(null)
            this._textContent = ''
            this._value = ''
        }
        get textContent() {
            return this._textContent
        }
        set textContent(val) {
            // W3C: 设置 textContent 时将作为纯文本替换所有子节点，绝不会由 HTML 语法分析器生成元素节点
            this._textContent = String(val)
            this.childNodes = []
        }
        get value() {
            return this._value
        }
        set value(val) {
            // option 的 value 属性为纯字符串，绝不解析 HTML 或触发事件
            this._value = String(val)
        }
        get innerHTML() {
            return this._textContent
        }
        set innerHTML(val) {
            // 生产安全要求：绝不允许通过 innerHTML 赋值渲染模型列表
            throw new Error('Security Violation: populateModelDatalist must not set innerHTML')
        }
        appendChild(child) {
            this.childNodes.push(child)
            return child
        }
        setAttribute(name, val) {
            this.attributes[String(name).toLowerCase()] = String(val)
        }
        getAttribute(name) {
            return this.attributes[String(name).toLowerCase()] ?? null
        }
    }

    const mockDatalist = new ControlledDOMNode('datalist')
    const doc = {
        getElementById: (id) => (id === 'aiModelDatalist' ? mockDatalist : null),
        createElement: (tag) => new ControlledDOMNode(tag)
    }

    const sandbox = {
        document: doc,
        Array,
        String
    }
    vm.createContext(sandbox)

    // 在隔离沙箱中加载并定义页面真实提取出来的 populateModelDatalist
    vm.runInContext(fnCode, sandbox)
    assert.equal(typeof sandbox.populateModelDatalist, 'function', '提取出的 populateModelDatalist 必须为可执行函数')

    // 覆盖典型不可信外部 AI 模型名称（包含各类常见 XSS 探测 Payload、伪协议、属性闭合、非字符串脏数据等）
    const maliciousModels = [
        '"><script>alert("xss-script")</script>',
        '"><img src=x onerror=alert("xss-img")>',
        '\' onfocus=\'alert("xss-focus")\' autofocus=\'',
        '<svg onload=alert("xss-svg")>',
        '"><iframe src="javascript:alert(1)"></iframe>',
        'javascript:alert("proto")',
        '   ',             // 纯空白字符串（应被安全过滤）
        null,              // 非字符串（应被安全过滤）
        undefined,         // 非字符串（应被安全过滤）
        12345,             // 数字类型（应被安全过滤）
        'gpt-4o-mini',     // 正常业务模型名
        'deepseek-chat'    // 正常业务模型名
    ]

    // 3. 执行真实函数渲染到受控 DOM
    sandbox.populateModelDatalist('aiModelDatalist', maliciousModels)

    // 验证仅过滤后保留的合法非空字符串有效添加到 datalist
    // 有效项：6 个恶意/特殊测试名 + 2 个正常模型名 = 共 8 个 option
    assert.equal(mockDatalist.childNodes.length, 8, 'datalist 应仅容纳过滤后的有效 option 项')

    // 递归收集 DOM 树中的所有节点信息
    function inspectSubtree(node) {
        let nodes = [node]
        for (const child of node.childNodes || []) {
            nodes = nodes.concat(inspectSubtree(child))
        }
        return nodes
    }

    const allNodesInDom = inspectSubtree(mockDatalist)
    const allTagNames = allNodesInDom.map(n => n.tagName)

    // 核心安全断言 1：验证最终 DOM 树中绝对没有被解析生成 script/img/svg/iframe/object 等可执行或加载标签节点
    assert.ok(
        !allTagNames.some(tag => ['SCRIPT', 'IMG', 'SVG', 'IFRAME', 'OBJECT', 'EMBED'].includes(tag)),
        `DOM 树中不得出现危险标签节点，当前存在标签: ${allTagNames.join(', ')}`
    )

    // 核心安全断言 2：验证挂载在 datalist 下的全部都是 OPTION 节点，并且每个 option 的子节点数为 0（未解析任何子元素）
    mockDatalist.childNodes.forEach((opt) => {
        assert.equal(opt.tagName, 'OPTION', `子节点必须为 OPTION，实际为 ${opt.tagName}`)
        assert.equal(opt.childNodes.length, 0, 'OPTION 节点内绝不得解析出任何子 HTML 节点')

        // 核心安全断言 3：验证 DOM 节点属性中没有任何以 on 开头的事件属性（如 onload/onerror/onfocus 等）
        const attrKeys = Object.keys(opt.attributes)
        const eventAttrs = attrKeys.filter(k => /^on/i.test(k))
        assert.equal(eventAttrs.length, 0, `节点不应包含任何事件属性: ${eventAttrs.join(', ')}`)

        // 核心安全断言 4：验证恶意字符串被完整作为纯文本属性值和纯文本内容对待（无截断或解析变异）
        assert.ok(typeof opt.value === 'string' && opt.value.length > 0)
        assert.equal(opt.value, opt.textContent, 'value 与 textContent 必须完全一致并保留纯文本')
    })
})

