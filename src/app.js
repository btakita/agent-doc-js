import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import { createPatch } from 'diff'

// --- Settings ---

function loadSettings() {
  return {
    apiKey: localStorage.getItem('agent-doc:apiKey') || '',
    model: localStorage.getItem('agent-doc:model') || 'claude-sonnet-4-6',
    systemPrompt: localStorage.getItem('agent-doc:systemPrompt') || '',
  }
}

function saveSettings(settings) {
  for (const key of ['apiKey', 'model', 'systemPrompt']) {
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

// --- Claude API ---

async function callClaude(apiKey, model, systemPrompt, diff, document) {
  const messages = [
    {
      role: 'user',
      content: `You are an agent-doc assistant. The user has edited a document. Respond to their changes.

<document>
${document}
</document>

<diff>
${diff}
</diff>

Respond with patch blocks targeting the document's components. Use this format:
<!-- patch:exchange -->
Your response here
<!-- /patch:exchange -->

For template documents, respond to the user's edits naturally. Address their questions, continue the conversation, and provide useful content.`,
    },
  ]

  const body = { model, max_tokens: 4096, messages }
  if (systemPrompt) body.system = systemPrompt

  const response = await fetch('https://api.anthropic.com/v1/messages', {
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
        lineNumbers(),
        history(),
        markdown(),
        oneDark,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            localStorage.setItem('agent-doc:document', update.state.doc.toString())
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

function setStatus(text) {
  document.getElementById('status-text').textContent = text
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
  document.getElementById('submit-btn').disabled = true
  setStatus('Calling Claude...')

  try {
    const response = await callClaude(
      settings.apiKey, settings.model, settings.systemPrompt, diff, currentDoc,
    )
    const updatedDoc = applyPatches(currentDoc, response)
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: updatedDoc },
    })
    setSnapshot(updatedDoc)
    setStatus('Response received')
  } catch (err) {
    setStatus(`Error: ${err.message}`)
    console.error(err)
  } finally {
    isProcessing = false
    document.getElementById('submit-btn').disabled = false
  }
}

function init() {
  const savedDoc = localStorage.getItem('agent-doc:document') || DEFAULT_DOC
  editor = createEditor(document.getElementById('editor'), savedDoc)

  if (!getSnapshot()) setSnapshot(savedDoc)

  document.getElementById('submit-btn').addEventListener('click', handleSubmit)

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  })

  // Settings dialog
  const dialog = document.getElementById('settings-dialog')
  const settings = loadSettings()

  document.getElementById('settings-btn').addEventListener('click', () => {
    document.getElementById('api-key-input').value = settings.apiKey
    document.getElementById('model-select').value = settings.model
    document.getElementById('system-prompt-input').value = settings.systemPrompt
    dialog.showModal()
  })

  document.getElementById('settings-cancel').addEventListener('click', () => dialog.close())

  dialog.addEventListener('close', () => {
    if (dialog.returnValue === '') return
    const newSettings = {
      apiKey: document.getElementById('api-key-input').value,
      model: document.getElementById('model-select').value,
      systemPrompt: document.getElementById('system-prompt-input').value,
    }
    saveSettings(newSettings)
    Object.assign(settings, newSettings)
    setStatus('Settings saved')
  })

  if (!settings.apiKey) setTimeout(() => dialog.showModal(), 500)
  setStatus('Ready — edit the document and press Ctrl+Enter to submit')
}

init()
