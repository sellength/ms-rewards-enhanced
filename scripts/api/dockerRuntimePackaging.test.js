import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

test('Dockerfile 运行时文件完整性与依赖链校验', () => {
    const dockerfilePath = path.join(projectRoot, 'Dockerfile')
    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8')

    // 1. 验证 Dockerfile 包含所有 Web 运行期必需的静态依赖与衍生子进程脚本
    const requiredFiles = [
        'web.mjs',
        'promotion-classification.mjs',
        'promotion-classification.cjs',
        'scripts/api/',
        'scripts/main/',
        'doctor.mjs',
        'mobile-doctor.mjs',
        'public/',
        'scripts/docker/entrypoint.sh'
    ]

    for (const relPath of requiredFiles) {
        assert.ok(
            dockerfileContent.includes(relPath),
            `Dockerfile 必须包含对 ${relPath} 的拷贝指令`
        )
        const fullPath = path.join(projectRoot, relPath)
        assert.ok(
            fs.existsSync(fullPath),
            `项目根目录下物理文件 ${relPath} 必须真实存在`
        )
        const stat = fs.statSync(fullPath)
        if (stat.isFile()) {
            assert.ok(stat.size > 0, `物理文件 ${relPath} 必须非空`)
        }
    }

    // 2. 验证 promotion-classification 模块链式引用合法性
    const mjsContent = fs.readFileSync(path.join(projectRoot, 'promotion-classification.mjs'), 'utf8')
    assert.ok(mjsContent.includes('./promotion-classification.cjs'), 'promotion-classification.mjs 必须正确引用 .cjs')
})

test('运行时脚本静态语法校验 (doctor.mjs / mobile-doctor.mjs / interactiveLogin.mjs)', () => {
    // 静态语法校验不依赖外部 node_modules 符号链接，在所有操作系统均可无损稳定执行
    const scriptsToCheck = [
        'doctor.mjs',
        'mobile-doctor.mjs',
        'scripts/main/interactiveLogin.mjs'
    ]

    for (const script of scriptsToCheck) {
        const checkResult = spawnSync(process.execPath, ['--check', path.join(projectRoot, script)], { encoding: 'utf8' })
        assert.equal(
            checkResult.status,
            0,
            `${script} 静态语法校验必须通过: ${checkResult.stderr || checkResult.stdout}`
        )
    }
})

test('本地运行时文件布局仿真测试：Web 模块依赖链与子进程脚本加载验证 (非真实构建镜像同构)', (t) => {
    // 说明：本测试通过复刻 Dockerfile 运行阶段的目标文件布局（使用宿主机编译的 dist/ 与宿主机 node_modules），
    // 验证 web.mjs 及其所有静态与动态导入链在布局仿真下的相对寻址正确性；
    // 本测试属于本地文件组织仿真，不代表 Docker 镜像真实构建与容器运行时端到端验证通过。
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-docker-staging-'))
    const tempSessionDir = path.join(stagingDir, 'sessions')
    fs.mkdirSync(tempSessionDir, { recursive: true })

    try {
        // 复制 Dockerfile 运行时阶段指定的文件集合
        const filesToCopy = [
            'package.json',
            'web.mjs',
            'promotion-classification.mjs',
            'promotion-classification.cjs',
            'doctor.mjs',
            'mobile-doctor.mjs'
        ]
        for (const file of filesToCopy) {
            fs.copyFileSync(path.join(projectRoot, file), path.join(stagingDir, file))
        }

        const dirsToCopy = ['scripts/api', 'scripts/main', 'public', 'dist']
        for (const dir of dirsToCopy) {
            fs.cpSync(path.join(projectRoot, dir), path.join(stagingDir, dir), { recursive: true })
        }

        // 跨平台链接：使用 junction (Windows) 或 dir (POSIX) 创建 node_modules 链接。
        // 注意：Node.js ESM 规范中模块解析算法不使用 NODE_PATH 环境变量。
        // 若宿主机环境因文件系统或权限限制无法创建目录联接/符号链接，显式跳过本项动态布局仿真并给出原因，杜绝虚假降级断言。
        const hostNodeModules = path.join(projectRoot, 'node_modules')
        const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
        try {
            fs.symlinkSync(hostNodeModules, path.join(stagingDir, 'node_modules'), symlinkType)
        } catch (linkErr) {
            t.skip(`当前环境无法创建目录联接/符号链接 (${linkErr.code || linkErr.message})，跳过动态模块加载仿真`)
            return
        }

        // 在本地仿真文件布局下验证 web.mjs 顶层动态加载与所有依赖链解析
        const loadResult = spawnSync(
            process.execPath,
            [
                '-e',
                `
                process.env.MS_SESSION_DIR = ${JSON.stringify(tempSessionDir)};
                process.env.MS_SESSION_DB_PATH = ${JSON.stringify(path.join(tempSessionDir, 'sessions.db'))};
                process.env.MS_WEB_PAIRING_SECRET = 'FictionalTestSecret2026!';
                import('./web.mjs').then(() => {
                    console.log('WEB_MJS_LOAD_SUCCESS');
                    process.exit(0);
                }).catch(err => {
                    console.error('LOAD_ERROR:', err);
                    process.exit(1);
                });
                `
            ],
            {
                cwd: stagingDir,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    NODE_ENV: 'production',
                    MS_SESSION_DIR: tempSessionDir,
                    MS_SESSION_DB_PATH: path.join(tempSessionDir, 'sessions.db'),
                    MS_WEB_PAIRING_SECRET: 'FictionalTestSecret2026!'
                }
            }
        )

        assert.equal(
            loadResult.status,
            0,
            `在仿真文件布局下加载 web.mjs 必须成功，实际输出: ${loadResult.stderr || loadResult.stdout}`
        )
        assert.ok(
            loadResult.stdout.includes('WEB_MJS_LOAD_SUCCESS'),
            '必须输出 WEB_MJS_LOAD_SUCCESS 标识'
        )

    } finally {
        try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch (_) {}
    }
})

test('.dockerignore 安全与打包规则校验：确保敏感文件全排除且运行时依赖不被误漏', () => {
    const dockerignorePath = path.join(projectRoot, '.dockerignore')
    assert.ok(fs.existsSync(dockerignorePath), '.dockerignore 必须存在')
    const ignoreContent = fs.readFileSync(dockerignorePath, 'utf8')
    const ignoreLines = ignoreContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

    // 1. 验证敏感凭据与本地数据必须被排除（防止打进 Docker 镜像造成泄露）
    const sensitiveRules = ['sessions/', '.env', 'accounts*.json', 'config/']
    for (const rule of sensitiveRules) {
        assert.ok(
            ignoreLines.some(l => l === rule || l.startsWith(rule)),
            `.dockerignore 必须明确排除敏感凭据或本地数据规则: ${rule}`
        )
    }

    // 2. 验证 Web 运行时必需文件绝对不能被 .dockerignore 规则直接排除
    const runtimeFiles = [
        'web.mjs',
        'promotion-classification.mjs',
        'promotion-classification.cjs',
        'doctor.mjs',
        'mobile-doctor.mjs'
    ]
    for (const file of runtimeFiles) {
        assert.ok(
            !ignoreLines.includes(file),
            `.dockerignore 绝不可排除 Web 运行时必需文件: ${file}`
        )
    }
})
