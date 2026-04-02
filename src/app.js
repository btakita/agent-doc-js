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
  // If response has no patch blocks, wrap it in a default exchange patch
  if (!response.includes('<!-- patch:')) {
    response = `<!-- patch:exchange -->\n### Re:\n\n${response}\n<!-- /patch:exchange -->`
  }

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

// --- Prompt injection scanner ---

function scanForInjection(text) {
  const warnings = []
  const patterns = [
    { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, label: '"Ignore previous instructions" directive' },
    { pattern: /you\s+are\s+now\s+/i, label: '"You are now..." role override' },
    { pattern: /\bsystem:\s/i, label: 'System prompt injection attempt' },
    { pattern: /\bact\s+as\s+(a|an)\s+/i, label: '"Act as..." role override' },
    { pattern: /do\s+not\s+follow\s+(the\s+)?(system|original)\s+/i, label: 'System prompt override attempt' },
    { pattern: /base64[^a-z]/i, label: 'Base64 encoded content (potential hidden instructions)' },
    { pattern: /\beval\s*\(/, label: 'JavaScript eval() call' },
    { pattern: /<script\b/i, label: 'Script tag injection' },
    { pattern: /\bpassword\b.*\b(reveal|show|display|output)\b/i, label: 'Credential extraction attempt' },
    { pattern: /\b(api[_-]?key|secret|token)\b.*\b(include|output|print|reveal)\b/i, label: 'Secret extraction attempt' },
  ]

  for (const { pattern, label } of patterns) {
    if (pattern.test(text)) {
      warnings.push(label)
    }
  }

  return warnings
}

// --- Default SKILL.md ---

const DEFAULT_SKILL = `You are an agent-doc assistant. You help users edit and develop documents interactively.

## Response Format

Respond with patch blocks targeting the document's template components:
\`\`\`
<!-- patch:exchange -->
Your response here
<!-- /patch:exchange -->
\`\`\`

## Knowledge Base (Ragie)

When you need information from the knowledge base to answer the user's question, output a search command:
<ragie-search query="your search query"/>

The system will execute the search and provide results. You can then use the results in your response.

When referencing retrieved content, cite the source document name in brackets, e.g. [2026-03-12-dogfooding-agent-doc-part1-blog.md]. This helps users trace information back to the original source.

## Pending Component

If the document has a \`<!-- agent:pending -->\` component, EVERY response MUST include a \`<!-- patch:pending -->\` block. This is not optional.

Format:
\`\`\`
<!-- patch:pending -->
- [x] Completed task
- [ ] Active task (in progress)
- [ ] New task discovered during conversation
<!-- /patch:pending -->
\`\`\`

Rules:
- Mark completed items with \`[x]\`, incomplete with \`[ ]\`
- Add new items discovered during the conversation
- Move active/priority items to the top
- Remove stale or irrelevant items
- Reflect the CURRENT state after your response

## Guidelines

- Respond naturally to user edits
- Address questions, continue conversations, provide useful content
- When retrieved context is provided, reference it when relevant
- Keep responses focused and concise
- NEVER echo back the user's text in your patch response — only include YOUR response content
- The patch content replaces/appends to the component — do not duplicate what's already there`

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

async function callClaudeRaw(apiKey, model, systemPrompt, messages) {
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

async function callClaude(apiKey, model, skillMd, diff, doc, ragieContext) {
  const systemPrompt = skillMd || DEFAULT_SKILL

  let userContent = `<document>\n${doc}\n</document>\n\n<diff>\n${diff}\n</diff>`

  if (ragieContext) {
    userContent += `\n\n<retrieved-context>\n${ragieContext}\n</retrieved-context>`
  }

  const messages = [{ role: 'user', content: userContent }]

  // First call
  let response = await callClaudeRaw(apiKey, model, systemPrompt, messages)

  // Check for <ragie-search> commands (max 3 iterations)
  const settings = loadSettings()
  for (let i = 0; i < 3; i++) {
    const searchMatch = response.match(/<ragie-search\s+query="([^"]+)"\s*\/>/)
    if (!searchMatch || !settings.ragieKey) break

    const query = searchMatch[1]
    termLog(`Claude requested search: "${query}"`, 'log-context')

    const results = await searchRagie(settings.ragieKey, settings.proxyUrl, query)
    if (!results) {
      termLog('No results from knowledge base', 'log-info')
      break
    }

    const chunkCount = (results.match(/---/g) || []).length + 1
    termLog(`Retrieved ${chunkCount} chunks for "${query}"`, 'log-context')

    // Send results back to Claude
    messages.push({ role: 'assistant', content: response })
    messages.push({ role: 'user', content: `<search-results query="${query}">\n${results}\n</search-results>\n\nNow provide your response using these search results.` })

    response = await callClaudeRaw(apiKey, model, systemPrompt, messages)
  }

  // Strip any remaining <ragie-search> tags from the final response
  return response.replace(/<ragie-search\s+query="[^"]*"\s*\/>/g, '').trim()
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

## Pending

<!-- agent:pending patch=replace -->
- [ ] Start a conversation
<!-- /agent:pending -->
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
  setStatus('Calling Claude...')

  termLog('Calling Claude API...')

  try {
    const response = await callClaude(
      settings.apiKey, settings.model, settings.systemPrompt, diff, currentDoc, null,
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

  // Import button
  const importFile = document.getElementById('import-file')
  document.getElementById('import-btn').addEventListener('click', () => importFile.click())
  importFile.addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()

    // Scan for prompt injection patterns
    const warnings = scanForInjection(text)
    if (warnings.length > 0) {
      const warningText = warnings.map(w => `- ${w}`).join('\n')
      termLog(`WARNING: Potential prompt injection detected in "${file.name}"`, 'log-error')
      for (const w of warnings) termLog(`  ${w}`, 'log-error')
      if (!confirm(`Warning: Potential prompt injection detected:\n\n${warningText}\n\nLoad anyway?`)) {
        termLog('Import cancelled by user', 'log-info')
        importFile.value = ''
        return
      }
    }

    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
    })
    setSnapshot(text)
    localStorage.setItem('agent-doc:document', text)
    termLog(`Imported "${file.name}" (${text.length} chars)`, 'log-success')
    setStatus(`Imported: ${file.name}`)
    importFile.value = ''
  })

  // Export button
  document.getElementById('export-btn').addEventListener('click', () => {
    const doc = editor.state.doc.toString()
    // Collect terminal output
    const blob = new Blob([doc], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'agent-doc-export.md'
    a.click()
    URL.revokeObjectURL(url)
    termLog('Document exported (with terminal output)', 'log-success')
  })

  // Reset button
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (!confirm('Reset document to default? This clears all content and snapshot.')) return
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: DEFAULT_DOC },
    })
    setSnapshot(DEFAULT_DOC)
    localStorage.setItem('agent-doc:document', DEFAULT_DOC)
    termLog('Document reset to default', 'log-info')
    setStatus('Document reset')
  })

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
    document.getElementById('system-prompt-input').value = settings.systemPrompt || DEFAULT_SKILL
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

  document.getElementById('reset-skill-btn').addEventListener('click', () => {
    document.getElementById('system-prompt-input').value = DEFAULT_SKILL
  })

  if (!settings.apiKey) setTimeout(() => dialog.showModal(), 500)
  setStatus('Ready — edit the document and press Ctrl+Enter to submit')
}

init()
