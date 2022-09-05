// import ansiEscapes from 'ansi-escapes'
// const runAsync = require('run-async')
import { arc as dots } from 'cli-spinners'
import Debug from 'debug'
import Table from 'easy-table'
import figures from 'figures'
import isPlainObject from 'lodash.isplainobject'
import memoizeOne from 'memoize-one'
import type { Interface as ReadLineInterface } from 'readline'
import type { Observable, Subscription } from 'rxjs'
import { filter, takeWhile } from 'rxjs/operators'
import terminalSize from 'term-size'
import type { TreeNode } from './filter'
import { FilterPage } from './filter'
import type { KeypressEvent, PropsState, Row, TableSelectConfig, TableSelectContext } from './types'
import { Router, Status } from './types'
import { generateHelpText, SEPERATOR_CHAR, Shortcut } from './utils/common'
import { observeObject } from './utils/observe'
import { Paginator } from './utils/paginator'
import pc = require('picocolors')
import Base = require('inquirer/lib/prompts/base')
import observe = require('inquirer/lib/utils/events')
import utils = require('inquirer/lib/utils/readline')
import inquirer = require('inquirer')
import assert = require('assert')
import cliCursor = require('cli-cursor')
const debug = Debug('inquirer-table-select:index')

// TODO: 性能优化
// TODO: inquirer 的各种方法 支持 async，支持各种字段比如 filter transformer 等
export class TableSelectPrompt extends Base<TableSelectConfig & inquirer.Question> {
  protected pageSize: number = this.opt.pageSize || 15
  protected readonly paginator = new Paginator(this.screen, {
    isInfinite: this.opt.loop === undefined ? true : this.opt.loop,
    isShowHelp: false,
  })
  protected tabChoiceKey?: string
  protected tabChoiceList?: TreeNode[]

  protected _ui: PropsState = {
    isLoading: true,
    isToggledHelp: false,
    selectedIndex: 0,
    currentTabIndex: 0,
  }
  protected ui!: PropsState
  public status = Status.Pending
  protected answer: any
  protected done!: (value: any) => void

  protected isFiltersFirstRender: boolean = false
  protected context: TableSelectContext = { filters: {}, data: [] }

  protected router: Router = Router.NORMAL
  protected events!: ReturnType<typeof observe>
  protected observedObjectChange$!: Observable<PropsState>
  protected subscriptions!: Subscription[]

  get currentTabValue() {
    //@ts-ignore
    return this.tabChoiceList![this.ui.currentTabIndex]
  }

  get currentRow() {
    return this.context.data![this.ui.selectedIndex]
  }

  constructor(question: inquirer.Question<inquirer.Answers>, rl: ReadLineInterface, answers: inquirer.Answers) {
    super(question, rl, answers)
    const { data, source, tab } = this.opt

    this.opt.default = null // 禁用默认渲染行为

    assert.ok(data || source, new Error('Your muse provide `data` or `source` parameter'))
    if (!source && ['tree', 'loadingText'].some((v) => v in this.opt)) this.throwParamError('source')

    if (tab) this.initTab()
  }

  initTab(tab = this.opt.tab) {
    const { children, key } = tab!
    this.tabChoiceKey = key
    assert.ok(
      Array.isArray(children) && children.every((i) => typeof i === 'object'),
      new Error('Property `tab.children` cannot contain object items')
    )
    this.tabChoiceList = children

    if (tab!.default) {
      const currentTabIndex = children.indexOf(tab!.default)
      assert.ok(
        currentTabIndex !== -1,
        'Property `tab.children` must contain the value you set in property `tab.default`'
      )
      this._ui.currentTabIndex = currentTabIndex
    }

    this.context.filters![key] = this.tabChoiceList![this._ui.currentTabIndex]
  }

  async _run(cb: (value: any) => void) {
    this.done = cb
    cliCursor.hide()

    const [observedObject, observedObjectChange$] = observeObject(this._ui)
    this.ui = observedObject
    this.observedObjectChange$ = observedObjectChange$

    await this.createSpinner(async () => {
      await this.fetchData()
    })

    debug('_run')
    this.renderNormal()

    const events = observe(this.rl)
    this.events = events
    this.subscribe()

    return this
  }

  subscribe(events: ReturnType<typeof observe> = this.events) {
    const dontHaveAnswer = () => this.answer === undefined
    const filterLoadings = () => this.ui.isLoading === false

    const subObjectChange = this.observedObjectChange$
      .pipe(takeWhile(dontHaveAnswer), filter(filterLoadings))
      .subscribe((changes: any) => {
        debug(changes)
        this.renderNormal()
      })

    const subEventsLine = events.line
      .pipe(takeWhile(dontHaveAnswer), filter(filterLoadings))
      .subscribe(this.onSubmit.bind(this))
    const subEventsKeypress = events.keypress
      .pipe(takeWhile(dontHaveAnswer), filter(filterLoadings))
      .subscribe(this.onKeypress.bind(this))

    this.subscriptions = [subObjectChange, subEventsLine, subEventsKeypress]
  }

  unsubscribe(subscriptions = this.subscriptions || []) {
    subscriptions?.forEach((sub) => sub.unsubscribe())
  }

  onKeypress(event: KeypressEvent) {
    const keyName = event?.key?.name || undefined

    if (event.key.name === 'q') process.exit(0)

    // if (this.ui.isToggledHelp) return
    if (keyName === 'h' || event.key.sequence === '?' || event.key.sequence === '？') {
      this.onHelpKey()
    } else if (keyName === 'down' || (keyName === 'n' && event.key.ctrl)) {
      this.onDownKey()
    } else if (keyName === 'up' || (keyName === 'p' && event.key.ctrl)) {
      this.onUpKey()
    } else if (keyName === 'left') {
      if (this.context.pagination?.hasPreviousPage && this.opt.prev) this.onLeftKey()
    } else if (keyName === 'right') {
      if (this.context.pagination?.hasNextPage && this.opt.next) this.onRightKey()
    } else if (event.key.sequence === '/' || keyName === 'f') {
      if (this.opt.tree) this.onSlashKey()
    } else if (keyName === 'tab') {
      if (this.opt.tab) this.onTabKey()
    }
  }
  onHelpKey() {
    this.ui.isToggledHelp = !this.ui.isToggledHelp
  }
  onDownKey() {
    let index = this.ui.selectedIndex
    do {
      index = index < this.context.data!.length - 1 ? index + 1 : 0
    } while (!isRowSelectable(this.context.data![index]))
    this.ui.selectedIndex = index
    utils.up(this.rl, 2)
  }
  onUpKey() {
    let index = this.ui.selectedIndex
    do {
      index = index > 0 ? index - 1 : this.context.data!.length - 1
    } while (!isRowSelectable(this.context.data![index]))
    this.ui.selectedIndex = index
  }
  onLeftKey() {
    const patch = this.opt.prev?.(this.context.pagination!, this.context) || {}

    const payload = { ...this.context, ...patch }
    this.request(payload).then(() => {
      this.context = payload
      this.renderNormal()
    })
  }
  onRightKey() {
    const patch = this.opt.next?.(this.context.pagination!, this.context) || {}

    const payload = { ...this.context, ...patch }
    this.request(payload).then(() => {
      this.context = payload
      this.renderNormal()
    })
  }
  onSlashKey() {
    this.router = Router.FILTER
    this.unsubscribe()

    this.createSpinner(async () => {
      const filterPage = new FilterPage(this.rl, this.screen, this.events, {
        tree: this.opt.tree!,
        message: `${this.getQuestion()}
  ${pc.gray('Filters:')}
`,
        treeDefault: this.isFiltersFirstRender ? this.context.filters : this.opt.treeDefault,
      })
      filterPage.subscribe()

      await filterPage!._run(async (options: any) => {
        this.router = Router.NORMAL
        filterPage!.unsubscribe()

        if (typeof options === 'object') {
          await this.createSpinner(async () => {
            const payload = { ...this.context, filters: options }
            await this.request(payload)
            this.context = payload
            if (this.opt.tab && this.opt.tree?.some((node) => node.key === this.tabChoiceKey!)) this.updateTabState()
            // this.renderNormal()
            // this.subscribe()
          })
        }

        this.renderNormal()
        this.subscribe()
      })

      this.isFiltersFirstRender = true
    })
  }
  onTabKey() {
    if (this.tabChoiceList) {
      const payload = { ...this.context, [this.tabChoiceKey!]: this.currentTabValue }
      this.request(payload).then(() => {
        this.ui.currentTabIndex = (this.ui.currentTabIndex + 1) % this.tabChoiceList!.length

        this.context = payload
      })
    }
  }
  onSubmit(_line?: string) {
    this.status = Status.Done
    this.answer = (this.currentRow.short || this.currentRow.name || this.currentRow.value) ?? this.currentRow.row
    this.screen.render(`${this.getQuestion()}${pc.cyan(this.answer)}`, '')

    this.screen.done()
    cliCursor.show()

    this.done(this.currentRow.value ?? this.currentRow.row)
  }

  updateTabState() {
    const newTabValue: any = this.context.filters![this.tabChoiceKey!]

    const newTabIndex = this.tabChoiceList!.indexOf(newTabValue)
    if (newTabIndex !== -1) this._ui.currentTabIndex = newTabIndex
  }

  async fetchData(payload = this.context || {}) {
    if (this.opt.source) {
      debug('renderData::source')
      this.ui.selectedIndex = 0
      this.ui.isLoading = true
      // await this.createSpinner(
      //   async () => {
      await this.request(payload)
      //   }
      // )
      const selectedIndex = this.context.data!.findIndex((v: any) => v.value === this.opt?.default)
      this.ui.selectedIndex = selectedIndex !== -1 ? selectedIndex : 0
      this.ui.isLoading = false
    } else if (this.opt.data) {
      debug('fetchData start')
      this.ui.isLoading = true
      this.context.data = validateData(this.opt.data)
      const selectedIndex = this.context.data.findIndex((row) => row.value === this.opt?.default)
      this.ui.selectedIndex = selectedIndex !== -1 ? selectedIndex : 0
      this.ui.isLoading = false
      debug('fetchData end')
    }
  }

  async request(requestOpts = this.context || {}) {
    let thisPromise: Promise<TableSelectContext>
    try {
      const result = this.opt.source!(this.answers, requestOpts)
      thisPromise = Promise.resolve(result)
    } catch (error) {
      thisPromise = Promise.reject(error)
    }

    const lastPromise = thisPromise
    const patch = await thisPromise
    assert.ok(isPlainObject(patch), new Error('`Source` method must return a plain object'))
    const { data, pagination: newPagination, ...rest } = patch
    assert.ok(Array.isArray(data), new Error(`\`Source\` method must return ${pc.green('{ data: Row[] }')}`))
    if (thisPromise !== lastPromise) return

    this.context.data = validateData(data)
    if (newPagination) this.context.pagination = newPagination
    this.context = { ...this.context, ...rest }
  }

  renderNormal(error?: string) {
    debug('render')
    let content = this.getQuestion()
    let lines: string[] = []
    let bottomLines: string[] = []

    if (error) {
      lines = [`${pc.red('>> ')}${error}`]
      return this.screen.render(content, lines.join('\n'))
    }

    // Tab
    if (this.tabChoiceList?.length) lines.push(renderTab(this.tabChoiceList, this.ui.currentTabIndex))
    // Table
    if (this.context.data?.length) {
      const { head, body } = renderTable(this.context.data!, this.ui.selectedIndex)
      lines.push(pc.bgWhite(pc.bold(head[0])))
      const len = head[1].length

      if (this.ui.isLoading) lines.push('  ' + pc.dim(this.opt.loadingText || 'Loading...'))
      else {
        lines.push(this.paginator.paginate(body, this.ui.selectedIndex, this.pageSize))
        bottomLines.push(this.renderIndicator(len))
      }
      bottomLines.push(renderLine(len))
    } else {
      //   content += this.rl.line
      lines.push('  ' + pc.yellow(this.opt.emptyText || 'No results...'))
    }

    bottomLines.push('  ' + this.renderHelpText())
    lines.push(...bottomLines)

    this.screen.render(content, lines.join('\n'))
  }

  renderIndicator(limitSize: number) {
    let left = '  ' + `Select ${this.ui.selectedIndex + 1}/${this.context.data!.length}`
    let right = ''
    if (this.context.pagination) {
      const { currentPage, totalPages, hasNextPage, hasPreviousPage } = this.context.pagination
      if (typeof currentPage === 'number' && typeof totalPages === 'number')
        left += SEPERATOR_CHAR + `Page ${this.context.pagination.currentPage}/${this.context.pagination.totalPages}`

      const rightChunk = []
      hasPreviousPage && rightChunk.push(`← prev`)
      hasNextPage && rightChunk.push(`next →`)

      if (rightChunk.length) {
        right = rightChunk.join(SEPERATOR_CHAR)

        const spaceLen = limitSize - left.length - 2
        if (spaceLen > SEPERATOR_CHAR.length) {
          right = right.padStart(spaceLen, ' ').replace(right, rightChunk.map(pc.bold).join(SEPERATOR_CHAR))
        } else {
          right = pc.white(SEPERATOR_CHAR) + right
        }
      }
    }
    return '\n' + pc.dim(left) + pc.gray(right)
  }

  renderHelpText(isToggledHelp: boolean = this.ui.isToggledHelp) {
    const hideKeyMap: Shortcut[] = [
      { key: 'q', desc: 'quit' },
      { key: `enter`, desc: 'submit' },
      // { key: `↕`, desc: 'scroll' },
    ]
    const keyMap: Shortcut[] = []
    if (this.context.pagination) keyMap.push({ key: `↔`, desc: 'turn pages' })
    if (this.opt.tree) keyMap.push({ key: `/`, desc: 'filters' })
    if (this.opt.tab) keyMap.push({ key: `tab`, desc: 'switch tabs' })
    return generateHelpText({ keyMap, isToggledHelp, hideKeyMap, width: terminalSize().columns })
  }

  createSpinner = async (func: () => Promise<void>) => {
    const screen = this.screen
    const message = this.getQuestion().replace(`${pc.green('?')} `, '')
    const loadingText = this.opt.loadingText || 'Loading...'

    let spinnerIndex = 0
    const spinner = setInterval(() => {
      spinnerIndex++

      if (spinnerIndex >= dots.frames.length) {
        spinnerIndex = 0
      }

      const spinnerFrame = dots.frames[spinnerIndex]
      screen.render(
        `${pc.blue(spinnerFrame)} ${message}
  ${pc.dim(loadingText)}`,
        ''
      )
    }, dots.interval)

    await func()
    clearInterval(spinner)
    return spinner
  }
}

const renderTab = memoizeOne((tabs: TreeNode[], activeIndex: number) => {
  const seperator = '|'
  const res = tabs!
    .map((choice, index) => {
      //@ts-ignore
      const tabName: string = choice.short || choice.name || choice.value
      return activeIndex === index ? pc.bgCyan(` ${tabName} `) : ` ${tabName} `
    })
    .join(seperator)
  return `  ${pc.dim('Tab:')} ${res}`
})

const renderTable = memoizeOne((rowCollections: Row[], pointer: number) => {
  const text = Table.print(
    rowCollections,
    (item, cell) => {
      const entries = Object.entries(item.row)
      entries.forEach(([key, value], index) => {
        if (index === entries.length - 1) return cell(`${key}  `, value)
        return cell(key, value)
      })
    },
    (table) => {
      return table.toString().replace(/\n$/, '')
    }
  ).split('\n')

  const res = {
    head: text.slice(0, 2).map((str) => `  ${str}`),
    body: text
      .slice(2)
      .map((rowStr, i) => {
        if (!isRowSelectable(rowCollections[i])) {
          return `  ${pc.dim(rowStr)}`
        }
        const isSelected = i === pointer
        return isSelected ? `${pc.cyan(figures.pointer)} ${pc.cyan(rowStr)}` : `  ${rowStr}`
      })
      .join('\n'),
  }

  return res
})

const renderLine = memoizeOne((strokeSize: number) => {
  return `${'┈'.repeat(strokeSize)}`
})

const isRowSelectable = (row: Row) => {
  return row && !row.disabled
}

const validateData = (collection: Row[]) => {
  assert.ok(
    collection.every((row) => row.row),
    'Every data item must have a `row` property'
  )
  return collection
}
