const nodemailer = require('nodemailer')
const markdown = require('nodemailer-markdown').markdown

const progressBar = require('@jyeontu/progress-bar')
const readline = require('readline')

const { Gitlab } = require('gitlab')

const { token } = require('./config.json')

// 设置GitLab实例
const gitlab = new Gitlab({
  host: 'http://172.16.203.254/', // 替换为你的GitLab实例的URL
  token// 替换为你的GitLab访问令牌
})


const config = {
  duration: 100,
  current: 0,
  block: '█',
  showNumber: true,
  tip: {
    0: '努力加载中……',
    50: '加载一半啦，不要着急……',
    75: '马上就加载完了……',
    100: '加载完成'
  },
  color: 'blue'
}
var i = 0

var timer
let progressBarC = new progressBar(config)

const progressTick = ({ util, step = 3 } = {}) => {
  clearInterval(timer)
  i = i + (step ?? 3)
  if (util && typeof util === 'number') { i = util }
  timer = setInterval(() => {
    progressBarC.run(step ? i++ : i)
    if (i > 100) {
      clearInterval(timer)
    }
  }, 100)
}

const projectArr = ['console-fe', 'tspace-client','view-front', 'oe-uaa','electron-mmc']
const seriousError = ['语法错误', '逻辑错误', '安全漏洞']
const normalError = ['需求实现', '异常处理', '性能问题', '潜在问题', '多语言支持', '代码文字错误']
const usualError = ['代码优化', '风格规范', '冗余代码', '缺少日志或注释', '建议', '拼写规范']

// 获取本周的开始和结束
const getStartAndEndOfWeek = function () {
  const now = new Date()
  const startOfWeek = new Date(now)
  const endOfWeek = new Date(now)

  const diff = now.getDay() - 1 // 获取当前日期是星期几并减去1，因为星期天为0

  startOfWeek.setDate(now.getDate() - diff) // 设置为本周的第一天
  endOfWeek.setDate(now.getDate() + (6 - diff)) // 设置为本周的最后一天

  return {
    startOfWeek,
    endOfWeek
  }
}

// 判断日期是否在本周内
const isWithinThisWeek = function (date) {
  const now = new Date()
  const oneWeekAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000)) // 获取一周前的时间

  return date >= oneWeekAgo && date <= now
}


const getMRDetailList = async ({ startOfWeek, endOfWeek }) => {

  progressTick({ util: i })
  let projects = await gitlab.Projects.all()
  projects = projects.filter(p => projectArr.includes(p.name))

  progressTick()

  const mrDetailArr = []


  for (let [index, pj] of projects.entries()) {

    const mergeRequests = await gitlab.MergeRequests.all({ projectId: pj.id })

    progressTick()

    for (let mr of mergeRequests) {

      const { title, author, created_at, updated_at, target_branch, merged_by, state, web_url } = mr
      // 在周开始和周结束时间之外就跳过本次循环
      if (
        !(
          new Date(updated_at).getTime() >= startOfWeek.getTime() &&
          new Date(created_at).getTime() <= endOfWeek.getTime()
        )
      )
        continue

      // 获取评论
      let notes = await gitlab.MergeRequestNotes.all(pj.id, mr.iid)

      progressTick()

      notes = notes.filter(n => n.type === 'DiffNote')

      const commits = await gitlab.MergeRequests.commits(pj.id, mr.iid)

      progressTick()

      const notesBody = notes.map(n => n.body)
      let diffLines = []

      for (let cm of commits) {
        const commitDetail = await gitlab.Commits.show(pj.id, cm.id)

        progressTick()

        const {
          stats: { total }
        } = commitDetail
        diffLines.push(total)
      }
      const lines = diffLines.reduce((prev, cur) => prev + cur, 0)
      const errorMap = getErrorMap(notesBody)
      const score = getScoreByError(errorMap, lines)
      const notesClassification = getHistoryNotes(notes)

      mrDetailArr.push({
        projectName: pj.name,
        title,
        author: author.name,
        created_at,
        updated_at,
        target_branch,
        merged_by: merged_by?.username || '未合并',
        state,
        web_url,
        notesClassification,
        errorMap: getErrorMap(notesBody),
        lines,
        score
      })
    }

  }
  return mrDetailArr
}

// 统计代码评审不同错误类型的个数
const getErrorMap = noteList => {
  const errorMap = {
    serious: 0,
    normal: 0,
    usual: 0
  }
  //  判断三种级别 问题 个数分别是多少
  // 如果存在严重问题，不合格
  // 如果不存在严重问题，并且普通问题不超过3个， 合格
  // 如果 代码量 > 100 行，无严重问题，无普通问题， 良好
  // 如果 代码量大于100行以上，无问题  优秀
  noteList.forEach(n => {
    if (seriousError.some(e => n.includes(e))) {
      errorMap.serious++
    } else if (normalError.some(e => n.includes(e))) {
      errorMap.normal++
    } else if (usualError.some(e => n.includes(e))) {
      errorMap.usual++
    }
  })
  return errorMap
}

// 根据统计的错误，计算结果得分
const getScoreByError = (errorMap, diffLines) => {
  const { serious, normal, usual } = errorMap
  if (serious) {
    return '不合格'
  }
  if (normal <= 3) {
    return '合格'
  }
  if (!normal && diffLines > 100) {
    return '良好'
  }
  if (!usual && !normal && diffLines > 100) {
    return '优秀'
  }
}

// 拼接历史评论字符串
const getHistoryNotes = (notes) => {
  const inweekNotes = [], outweekNotes = []
  notes.forEach(n => {
    const { id, author: { username }, updated_at, body } = n
    const noteText = `Comment: ${id} ${username} ${new Date(updated_at).toLocaleString()} ${body}`
    if (isWithinThisWeek(new Date(updated_at).getTime())) {
      inweekNotes.push(noteText)
    } else {
      outweekNotes.push(noteText)
    }
  })
  return { inweekNotes, outweekNotes }
}

// 拼接 merge request 邮件markdown文本
const joinEmailText = m => {
  let { notesClassification: { inweekNotes, outweekNotes } } = m
  inweekNotes = inweekNotes.length ? inweekNotes.map(n => `- ${n}\n`) : '无'
  outweekNotes = outweekNotes.length ? outweekNotes.map(n => `- ${n}\n`) : '无'
  return `
---
# MR: ${m.title}

- 仓库名称：${m.projectName}
- 作者：${m.author}
- 创建时间：${new Date(m.created_at).toLocaleString()}
- 更新时间：${new Date(m.updated_at).toLocaleString()}
- 目标分支：${m.target_branch}
- 评审人：${m.merged_by}
- 当前状态：${m.state}
- 链接：${m.web_url}

## 近一周评审如下：

${inweekNotes}

## 历史评审如下：

${outweekNotes}

## 打分：

- 严重问题：${m.errorMap.serious}
- 普通问题：${m.errorMap.normal}
- 一般问题：${m.errorMap.usual}
- 代码变动行数：${m.lines}
- 评分：${m.score}

---
`
}

// 获取邮件文本
const getText = mrDetailList => {
  return mrDetailList.reduce((prev, cur) => {
    return prev + joinEmailText(cur)
  }, '')
}

// email发送
const sendEmailFn = async function (subject, text) {
  // 创建可重用的传输对象
  let transporter = nodemailer.createTransport({
    host: 'smtp.exmail.qq.com', // SMTP服务器主机名
    port: 465, // SMTP服务器端口号
    secure: true, // 使用TLS启用安全连接
    auth: {
      user: 'huangzijie@os-easy.com', // 发件人邮箱
      pass: '6BoQtRrs8jzkEfJS' // 发件人邮箱密码或授权码
    }
  })

  // 配置Markdown转换器
  transporter.use('compile', markdown())

  // 邮件内容设置
  const mailOptions = {
    // 发件人邮箱
    from: 'huangzijie@os-easy.com',
    // 收件人邮箱
    to: 'VDI项目组<vditeam@os-easy.com>',
    // 抄送
    cc: ['朱鹏<zhupeng@os-easy.com>', '王梦雄<wangmengxiong@os-easy.com>', '郝张青<haozhangqing02050@os-easy.com>', '胡晓思<huxiaosi@os-easy.com>'],
    // 主题
    subject,
    // markdown 或者 邮件正文（纯文本格式）
    markdown: text
  }

  try {
    // 发送邮件
    const info = await transporter.sendMail(mailOptions)
    console.log('邮件发送成功:', info.messageId)
  } catch (err) {
    console.error('邮件发送失败:', err)
    return null
  }
}

// 主函数 执行数据获取，邮件发送
async function main() {
  // 获取本周的开始日期和结束日期
  const { startOfWeek, endOfWeek } = getStartAndEndOfWeek()

  const mrDetailList = await getMRDetailList({ startOfWeek, endOfWeek })
  console.log(mrDetailList.length)
  const text = getText(mrDetailList)

  const subject = `本周：${startOfWeek.toLocaleDateString()}~${endOfWeek.toLocaleDateString()} 教育版前端，包含${projectArr.join('，')}等${projectArr.length}个仓库`
  console.log(subject)
  console.log(text)

  // 实例化readline
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  progressTick({
    util: 99, step: 0
  })

  // 询问用户选择
  rl.question('请选择操作：\n1. 发送邮件\n2. 取消发送\n', (answer) => {
    // 根据用户选择执行操作
    switch (answer) {
      case '1':
        console.log('发送邮件')
        sendEmailFn(subject, text)
        break
      case '2':
        console.log('取消发送')
        break
      default:
        console.log('无效的选择')
        break
    }
    progressTick({ util: 100 })
    // 关闭 readline 接口
    rl.close()
  })
}

main()
