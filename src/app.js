import { EditorView, keymap, lineNumbers, gutter, GutterMarker } from '@codemirror/view'
import { EditorState, StateField, StateEffect, RangeSet } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history as cmHistory, historyKeymap } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import { createPatch, diffLines } from 'diff'

// --- Diff gutter ---

const setDiffMarkers = StateEffect.define()

class DiffMarker extends GutterMarker {
  constructor(type) {
    super()
    this.type = type // 'added' | 'modified'
  }
  toDOM() {
    const el = document.createElement('div')
    el.className = `diff-marker diff-${this.type}`
    return el
  }
}

const addedMarker = new DiffMarker('added')
const modifiedMarker = new DiffMarker('modified')

const diffMarkerField = StateField.define({
  create: () => RangeSet.empty,
  update(set, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiffMarkers)) return e.value
    }
    return set
  },
})

const diffGutter = gutter({
  class: 'cm-diff-gutter',
  markers: (view) => view.state.field(diffMarkerField),
})

function computeDiffMarkers(state, snapshotText) {
  const currentLines = state.doc.toString().split('\n')
  const snapshotLines = snapshotText.split('\n')
  const markers = []

  const changes = diffLines(snapshotText, state.doc.toString())
  let currentLine = 0

  for (const part of changes) {
    const lines = part.value.split('\n')
    // diffLines includes trailing empty string from split
    const lineCount = part.value.endsWith('\n') ? lines.length - 1 : lines.length

    if (part.added) {
      for (let i = 0; i < lineCount; i++) {
        const lineNum = currentLine + i
        if (lineNum < state.doc.lines) {
          const pos = state.doc.line(lineNum + 1).from
          markers.push(addedMarker.range(pos))
        }
      }
      currentLine += lineCount
    } else if (part.removed) {
      // Removed lines don't exist in current doc, skip
    } else {
      currentLine += lineCount
    }
  }

  return RangeSet.of(markers, true)
}

// --- Settings ---

function loadSettings() {
  return {
    apiKey: localStorage.getItem('agent-doc:apiKey') || '',
    model: localStorage.getItem('agent-doc:model') || 'claude-haiku-4-5-20251001',
    proxyUrl: localStorage.getItem('agent-doc:proxyUrl') || '',
    ragieKey: localStorage.getItem('agent-doc:ragieKey') || '',
    systemPrompt: localStorage.getItem('agent-doc:systemPrompt') || '',
  }
}

function saveSettings(settings) {
  for (const key of ['apiKey', 'model', 'proxyUrl', 'ragieKey', 'systemPrompt']) {
    if (settings[key] != null) {
      localStorage.setItem(`agent-doc:${key}`, settings[key])
    }
  }
}

// --- Snapshot / Diff ---

function getSnapshot() {
  return localStorage.getItem('agent-doc:snapshot') || ''
}

function setSnapshot(content) {
  localStorage.setItem('agent-doc:snapshot', content)
}

function computeDiff(oldText, newText) {
  if (oldText === newText) return null
  return createPatch('document', oldText, newText, 'snapshot', 'current')
}

// --- Template patch application ---

function applyPatches(doc, response) {
  const patchRegex = /<!-- patch:(\w+) -->([\s\S]*?)<!-- \/patch:\1 -->/g
  let result = doc
  let match
  while ((match = patchRegex.exec(response)) !== null) {
    const name = match[1]
    const patchContent = match[2]
    const componentRegex = new RegExp(
      `(<!-- agent:${name}(?:\\s+[^>]*)? -->)[\\s\\S]*?(<!-- \\/agent:${name} -->)`,
    )
    const componentMatch = result.match(componentRegex)
    if (componentMatch) {
      const openTag = componentMatch[1]
      const isAppend = openTag.includes('patch=append')
      const isPrepend = openTag.includes('patch=prepend')
      if (isAppend) {
        const existingContent = componentMatch[0].slice(
          componentMatch[1].length,
          componentMatch[0].length - componentMatch[2].length,
        )
        result = result.replace(
          componentMatch[0],
          componentMatch[1] + existingContent + patchContent + componentMatch[2],
        )
      } else if (isPrepend) {
        const existingContent = componentMatch[0].slice(
          componentMatch[1].length,
          componentMatch[0].length - componentMatch[2].length,
        )
        result = result.replace(
          componentMatch[0],
          componentMatch[1] + patchContent + existingContent + componentMatch[2],
        )
      } else {
        result = result.replace(
          componentMatch[0],
          componentMatch[1] + patchContent + componentMatch[2],
        )
      }
    }
  }
  return result
}

// --- Ragie retrieval ---

async function searchRagie(ragieKey, proxyUrl, query) {
  if (!ragieKey || !query) return null

  const apiUrl = proxyUrl
    ? `${proxyUrl.replace(/\/$/, '')}/ragie/retrievals`
    : 'https://api.ragie.ai/retrievals'

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ragieKey}`,
      },
      body: JSON.stringify({ query, rerank: true }),
    })

    if (!response.ok) return null

    const data = await response.json()
    const chunks = data.scored_chunks || []
    // Return top 5 chunks formatted as context
    return chunks.slice(0, 5).map(c =>
      `[${c.document_name}] (score: ${c.score?.toFixed(2)})\n${c.text}`
    ).join('\n\n---\n\n')
  } catch {
    return null
  }
}

// --- Claude API ---

async function callClaude(apiKey, model, systemPrompt, diff, document, ragieContext) {
  let userContent = `You are an agent-doc assistant. The user has edited a document. Respond to their changes.

<document>
${document}
</document>

<diff>
${diff}
</diff>`

  if (ragieContext) {
    userContent += `

<retrieved-context>
The following documents were retrieved from the knowledge base and may be relevant:

${ragieContext}
</retrieved-context>`
  }

  userContent += `

Respond with patch blocks targeting the document's components. Use this format:
<!-- patch:exchange -->
Your response here
<!-- /patch:exchange -->

For template documents, respond to the user's edits naturally. Address their questions, continue the conversation, and provide useful content.`

  if (ragieContext) {
    userContent += ` When relevant, reference information from the retrieved context.`
  }

  const messages = [{ role: 'user', content: userContent }]

  const body = { model, max_tokens: 4096, messages }
  if (systemPrompt) body.system = systemPrompt

  // Use proxy URL if configured, otherwise direct API
  const proxyUrl = localStorage.getItem('agent-doc:proxyUrl')
  const apiUrl = proxyUrl
    ? `${proxyUrl.replace(/\/$/, '')}/v1/messages`
    : 'https://api.anthropic.com/v1/messages'

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Claude API error (${response.status}): ${error}`)
  }

  const data = await response.json()
  return data.content[0].text
}

// --- Editor ---

function createEditor(container, initialContent) {
  return new EditorView({
    state: EditorState.create({
      doc: initialContent,
      extensions: [
        // Ctrl+Enter to submit — must come before defaultKeymap to prevent newline insertion
        keymap.of([{
          key: 'Ctrl-Enter',
          mac: 'Cmd-Enter',
          run: () => { handleSubmit(); return true },
        }]),
        diffMarkerField,
        diffGutter,
        lineNumbers(),
        cmHistory(),
        markdown(),
        oneDark,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            localStorage.setItem('agent-doc:document', update.state.doc.toString())
            // Update diff gutter
            const snapshot = getSnapshot()
            if (snapshot) {
              const markers = computeDiffMarkers(update.state, snapshot)
              update.view.dispatch({ effects: setDiffMarkers.of(markers) })
            }
          }
        }),
      ],
    }),
    parent: container,
  })
}

// --- App ---

const DEFAULT_DOC = `---
agent_doc_format: template
---

## Exchange

<!-- agent:exchange patch=append -->
Welcome to agent-doc. Start typing below and click Submit (or Ctrl+Enter) to get a response.

<!-- /agent:exchange -->
`

let editor
let isProcessing = false

// Expose for testing via DevTools
window.__agentDoc = { get editor() { return editor } }

function setStatus(text) {
  document.getElementById('status-text').textContent = text
}

function termLog(text, cls = 'log-info') {
  const output = document.getElementById('terminal-output')
  if (!output) return
  const line = document.createElement('div')
  const ts = new Date().toLocaleTimeString()
  line.innerHTML = `<span class="log-timestamp">[${ts}]</span> <span class="${cls}">${text}</span>`
  output.appendChild(line)
  output.scrollTop = output.scrollHeight
}

async function handleSubmit() {
  if (isProcessing) return

  const settings = loadSettings()
  if (!settings.apiKey) {
    document.getElementById('settings-dialog').showModal()
    setStatus('Please set your API key first')
    return
  }

  const currentDoc = editor.state.doc.toString()
  const snapshot = getSnapshot()
  const diff = computeDiff(snapshot, currentDoc)

  if (!diff) {
    setStatus('No changes to submit')
    return
  }

  isProcessing = true
  const submitBtn = document.getElementById('submit-btn')
  submitBtn.disabled = true
  submitBtn.textContent = 'Submitting...'
  document.getElementById('status-bar').classList.add('loading')

  termLog(`Submitting (model: ${settings.model})`)
  termLog(`Diff: ${diff.split('\n').length} lines changed`)

  // Search Ragie for relevant context (if configured)
  let ragieContext = null
  if (settings.ragieKey) {
    setStatus('Searching knowledge base...')
    termLog('Searching Ragie knowledge base...')
    const addedLines = diff.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1)).join(' ').slice(0, 500)
    ragieContext = await searchRagie(settings.ragieKey, settings.proxyUrl, addedLines)
    if (ragieContext) {
      const chunkCount = (ragieContext.match(/---/g) || []).length + 1
      termLog(`Retrieved ${chunkCount} chunks from knowledge base`, 'log-context')
      setStatus('Context retrieved. Calling Claude...')
    } else {
      termLog('No relevant context found in knowledge base')
      setStatus('Calling Claude...')
    }
  } else {
    setStatus('Calling Claude...')
  }

  termLog('Calling Claude API...')

  try {
    const response = await callClaude(
      settings.apiKey, settings.model, settings.systemPrompt, diff, currentDoc, ragieContext,
    )
    termLog(`Response: ${response.length} chars`, 'log-success')
    const updatedDoc = applyPatches(currentDoc, response)
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: updatedDoc },
    })
    setSnapshot(updatedDoc)
    termLog('Document updated', 'log-success')
    setStatus('Response received')
  } catch (err) {
    termLog(`Error: ${err.message}`, 'log-error')
    setStatus(`Error: ${err.message}`)
    console.error(err)
  } finally {
    isProcessing = false
    submitBtn.disabled = false
    submitBtn.textContent = 'Submit'
    document.getElementById('status-bar').classList.remove('loading')
  }
}

function applyHashParams() {
  const hash = window.location.hash.slice(1)
  if (!hash) return false
  const params = new URLSearchParams(hash)
  let applied = false
  for (const [key, value] of params) {
    if (value && ['apiKey', 'model', 'proxyUrl', 'ragieKey', 'systemPrompt'].includes(key)) {
      localStorage.setItem(`agent-doc:${key}`, value)
      applied = true
    }
  }
  // Clear hash to avoid leaking credentials in URL
  if (applied) {
    window.history.replaceState(null, '', window.location.pathname)
  }
  return applied
}

function init() {
  // Auto-populate from URL hash params (from setup.sh)
  applyHashParams()

  const savedDoc = localStorage.getItem('agent-doc:document') || DEFAULT_DOC
  editor = createEditor(document.getElementById('editor'), savedDoc)

  if (!getSnapshot()) setSnapshot(savedDoc)

  document.getElementById('submit-btn').addEventListener('click', handleSubmit)

  // Terminal toggle/clear
  document.getElementById('terminal-toggle').addEventListener('click', (e) => {
    e.stopPropagation()
    document.getElementById('terminal-container').classList.toggle('collapsed')
  })
  document.getElementById('terminal-header').addEventListener('click', () => {
    document.getElementById('terminal-container').classList.toggle('collapsed')
  })
  document.getElementById('terminal-clear').addEventListener('click', (e) => {
    e.stopPropagation()
    document.getElementById('terminal-output').innerHTML = ''
  })
  // Terminal prompt input
  const termInput = document.getElementById('terminal-input')
  termInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !termInput.value.trim()) return
    const cmd = termInput.value.trim()
    termInput.value = ''
    termLog(`&gt; ${cmd}`)

    // Send as a direct Claude prompt (not document edit)
    const s = loadSettings()
    if (!s.apiKey) {
      termLog('No API key configured', 'log-error')
      return
    }

    termLog('Running...', 'log-info')
    try {
      const proxyUrl = localStorage.getItem('agent-doc:proxyUrl')
      const apiUrl = proxyUrl
        ? `${proxyUrl.replace(/\/$/, '')}/v1/messages`
        : 'https://api.anthropic.com/v1/messages'

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': s.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: s.model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: cmd }],
        }),
      })

      if (!resp.ok) {
        const err = await resp.text()
        termLog(`Error (${resp.status}): ${err.slice(0, 200)}`, 'log-error')
        return
      }

      const data = await resp.json()
      const text = data.content[0].text
      // Display response line by line
      for (const line of text.split('\n')) {
        termLog(line, 'log-success')
      }
    } catch (err) {
      termLog(`Error: ${err.message}`, 'log-error')
    }
  })

  termLog('agent-doc-js initialized', 'log-success')

  // Toolbar model dropdown — auto-saves on change
  const modelToolbar = document.getElementById('model-toolbar')
  const settings = loadSettings()
  modelToolbar.value = settings.model
  modelToolbar.addEventListener('change', () => {
    settings.model = modelToolbar.value
    localStorage.setItem('agent-doc:model', modelToolbar.value)
    setStatus(`Model: ${modelToolbar.options[modelToolbar.selectedIndex].text}`)
  })

  // Settings dialog
  const dialog = document.getElementById('settings-dialog')

  document.getElementById('settings-btn').addEventListener('click', () => {
    document.getElementById('api-key-input').value = settings.apiKey
    document.getElementById('model-select').value = settings.model
    document.getElementById('proxy-url-input').value = settings.proxyUrl
    document.getElementById('ragie-key-input').value = settings.ragieKey
    document.getElementById('system-prompt-input').value = settings.systemPrompt
    dialog.showModal()
  })

  document.getElementById('settings-save').addEventListener('click', (e) => {
    e.preventDefault()
    const newSettings = {
      apiKey: document.getElementById('api-key-input').value,
      model: document.getElementById('model-select').value,
      proxyUrl: document.getElementById('proxy-url-input').value,
      ragieKey: document.getElementById('ragie-key-input').value,
      systemPrompt: document.getElementById('system-prompt-input').value,
    }
    saveSettings(newSettings)
    Object.assign(settings, newSettings)
    modelToolbar.value = newSettings.model
    setStatus('Settings saved')
    dialog.close()
  })

  document.getElementById('settings-cancel').addEventListener('click', () => dialog.close())

  if (!settings.apiKey) setTimeout(() => dialog.showModal(), 500)
  setStatus('Ready — edit the document and press Ctrl+Enter to submit')
}

init()
