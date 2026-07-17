import { useState } from 'react'
import './App.css'

// Placeholder logic — will be replaced by a real backend call later
function getFakeAnswer(question) {
  const isGovernance = /polic|govern|law|act|regulation/i.test(question)
  return {
    answer: `This is a placeholder answer for: "${question}". Once connected to the real backend, this will be generated from Jala-AI's document corpus.`,
    tier: 'curated', // 'curated' | 'web_verified' | 'pending'
    category: isGovernance ? 'governance' : 'technical', // 'technical' | 'governance' | 'general'
    source: 'Sample Document, p. 12',
  }
}

const tierLabels = {
  curated: { label: 'Curated source', color: '#0f766e' },
  web_verified: { label: 'Web-sourced, verified', color: '#a16207' },
  pending: { label: 'Pending review', color: '#b91c1c' },
}

function App() {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)

  function handleAsk() {
    if (!question.trim()) return
    setLoading(true)
    setResult(null)
    setTimeout(() => {
      setResult(getFakeAnswer(question))
      setLoading(false)
    }, 600)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleAsk()
  }

  return (
    <div className="jala-container">
      <header className="jala-header">
        <h1>Jala-AI</h1>
        <p>Ask anything about water — fundamentals, applications, governance</p>
      </header>

      <div className="jala-ask-box">
        <input
          type="text"
          placeholder="e.g. What is the permissible fluoride limit in drinking water?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button onClick={handleAsk} disabled={loading}>
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </div>

      {result && (
        <div className="jala-answer">
          <div className="jala-badges">
            <span
              className="jala-badge"
              style={{ backgroundColor: tierLabels[result.tier].color }}
            >
              {tierLabels[result.tier].label}
            </span>
            {result.category === 'governance' && (
              <span className="jala-badge jala-badge-warning">
                ⚠ Policy/legal — verify against current official source
              </span>
            )}
          </div>
          <p className="jala-answer-text">{result.answer}</p>
          <p className="jala-answer-source">Source: {result.source}</p>
        </div>
      )}
    </div>
  )
}

export default App