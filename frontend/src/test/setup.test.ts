import { describe, it, expect } from 'vitest'

describe('Vitest setup', () => {
  it('should have jsdom environment available', () => {
    expect(document).toBeDefined()
    expect(window).toBeDefined()
  })

  it('should have jest-dom matchers available', () => {
    const element = document.createElement('div')
    element.textContent = 'Hello'
    document.body.appendChild(element)

    expect(element).toBeInTheDocument()
    expect(element).toHaveTextContent('Hello')

    document.body.removeChild(element)
  })
})
