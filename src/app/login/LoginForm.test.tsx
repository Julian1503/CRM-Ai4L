import { render, screen } from '@testing-library/react'

const mockLogin = jest.fn()
let currentState: { error: string | null; fieldErrors?: Record<string, string> } = { error: null }

jest.mock('./actions', () => ({
  login: (...args: unknown[]) => mockLogin(...args),
  INITIAL_LOGIN_STATE: { error: null },
}))

// useActionState drives this component; the state is what matters, not the transition.
jest.mock('react', () => {
  const actual = jest.requireActual('react')
  return {
    ...actual,
    useActionState: () => [currentState, jest.fn()],
  }
})

jest.mock('react-dom', () => {
  const actual = jest.requireActual('react-dom')
  return { ...actual, useFormStatus: () => ({ pending: false }) }
})

import LoginForm from './LoginForm'

describe('LoginForm', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    currentState = { error: null }
  })

  it('labels both fields for assistive technology', () => {
    render(<LoginForm nextPath="/" />)

    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  it('uses autocomplete tokens so password managers work', () => {
    render(<LoginForm nextPath="/" />)

    expect(screen.getByLabelText('Email address')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'current-password'
    )
  })

  it('carries the sanitised destination in a hidden field', () => {
    const { container } = render(<LoginForm nextPath="/contacts" />)

    expect(container.querySelector('input[name="next"]')).toHaveValue('/contacts')
  })

  it('announces an authentication failure to screen readers', () => {
    currentState = { error: 'Invalid email or password.' }

    render(<LoginForm nextPath="/" />)

    const alert = screen.getByTestId('login-error')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent('Invalid email or password.')
  })

  it('ties a field error to its input via aria-describedby', () => {
    currentState = { error: null, fieldErrors: { email: 'Enter your email address.' } }

    render(<LoginForm nextPath="/" />)

    const input = screen.getByLabelText('Email address')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', 'email-error')
    expect(screen.getByText('Enter your email address.')).toHaveAttribute('id', 'email-error')
  })

  it('marks only the field that failed', () => {
    currentState = { error: null, fieldErrors: { password: 'Enter your password.' } }

    render(<LoginForm nextPath="/" />)

    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Email address')).not.toHaveAttribute('aria-invalid')
  })

  it('renders no error region when there is nothing wrong', () => {
    render(<LoginForm nextPath="/" />)

    expect(screen.queryByTestId('login-error')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
