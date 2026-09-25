import React, { useState, useRef, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { IconButton, Box, Typography } from '@mui/material';
import { ContentCopy, Check } from '@mui/icons-material';
import StreamingIndicator from './StreamingIndicator';
import ToolIndicator, { ToolExecution } from './ToolIndicator';
import chatStore from '../stores/chatStore';

/**
 * Check if a message represents an error (either from streaming or from DB).
 */
function isErrorMessage(message) {
  return !!(message.isError || message.role === 'error' || message.error_message);
}

/**
 * Check if a message is a system/finish notification (content_filter, empty, etc.)
 */
function isFinishMessage(message) {
  return !!(message.isFinish || (message.finishReason && message.finishReason !== 'max_iterations'));
}

/**
 * Check if a message is a tool execution message.
 */
function isToolMessage(message) {
  return message.role === 'tool';
}

/**
 * Check if a message is an approval request message.
 */
function isApprovalRequestMessage(message) {
  return message.role === 'approval_request';
}

/**
 * Check if a message is an approval response message.
 */
function isApprovalResponseMessage(message) {
  return message.role === 'approval_approved' || message.role === 'approval_denied';
}



function MessageContent({ message }) {
  const content = message.error_message || message.content;

  function CodeBlock({ className, children }) {
    const match = /language-(\w+)/.exec(className || '');
    const codeString = String(children).replace(/\n$/, '');
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
      await navigator.clipboard.writeText(codeString);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };

    return (
      <div style={{ position: 'relative' }}>
        <IconButton
          onClick={handleCopy}
          size="small"
          sx={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 1,
            color: '#fff',
            backgroundColor: 'rgba(255,255,255,0.12)',
            '&:hover': { backgroundColor: 'rgba(255,255,255,0.22)' }
          }}
        >
          {copied ? <Check fontSize="small" /> : <ContentCopy fontSize="small" />}
        </IconButton>
        <SyntaxHighlighter
          style={vscDarkPlus}
          language={match ? match[1] : 'text'}
          PreTag="div"
          customStyle={{
            margin: '0.5em 0',
            borderRadius: '4px',
            fontSize: '0.875rem',
            paddingTop: '2.25em'
          }}
        >
          {codeString}
        </SyntaxHighlighter>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'left', '& p': { margin: '0 0 0.5em 0', textAlign: 'left' }, '& code': { background: 'transparent' } }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match && !className;

            return isInline ? (
              <code className={className} {...props} style={{
                padding: '2px 4px',
                borderRadius: '4px',
                fontSize: '0.875em',
                fontFamily: 'monospace'
              }}>
                {children}
              </code>
            ) : (
              <CodeBlock className={className} children={children} />
            );
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function FinishMessage({ message }) {
  const reasonLabels = {
    'content_filter': 'Content blocked',
    'empty_content': 'Resposta vazia',
    'length': 'Resposta truncada',
    'max_iterations': 'Iteration limit',
    'no_choices': 'Invalid response',
    'null_response': 'Resposta vazia',
    'cancelled': 'Operation cancelled'
  };

  const reasonIcons = {
    'content_filter': '🛡️',
    'empty_content': '📭',
    'length': '✂️',
    'max_iterations': '🔄',
    'no_choices': '⚠️',
    'null_response': '📭',
    'cancelled': '⏹️'
  };

  const label = reasonLabels[message.finishReason] || `Finish: ${message.finishReason}`;
  const icon = reasonIcons[message.finishReason] || 'ℹ️';

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'flex-start',
      marginBottom: '1em'
    }}>
      <div style={{
        width: '90%',
        padding: '0.75em',
        borderRadius: '8px',
        backgroundColor: '#fff8e1',
        border: '1px solid #ffe082',
        color: '#6d4c00',
        wordWrap: 'break-word'
      }}>
        <div style={{
          fontWeight: 600,
          marginBottom: '0.3em',
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}>
          <span style={{ fontSize: '1em' }}>{icon}</span>
          <span>{label}</span>
        </div>
        <div style={{ fontSize: '0.9em' }}>
          <MessageContent message={message} />
        </div>
        <div style={{
          fontSize: '0.75em',
          opacity: 0.7,
          marginTop: '0.5em',
          textAlign: 'left'
        }}>
          {message.created_at ? new Date(message.created_at).toLocaleTimeString() : ''}
        </div>
      </div>
    </div>
  );
}

function ErrorMessage({ message }) {
  const [expanded, setExpanded] = useState(false);

  // Try to parse error_message if it's a stringified JSON
  let errorDetails = null;
  if (message.error_message) {
    try {
      errorDetails = JSON.parse(message.error_message);
    } catch {
      errorDetails = message.error_message;
    }
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'flex-start',
      marginBottom: '1em'
    }}>
      <div style={{
        width: '90%',
        padding: '0.75em',
        borderRadius: '8px',
        backgroundColor: '#fde8e8',
        border: '1px solid #f5c6cb',
        color: '#721c24',
        wordWrap: 'break-word'
      }}>
        <div style={{
          fontWeight: 600,
          marginBottom: '0.3em',
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}>
          <span style={{ fontSize: '1em' }}>⚠️</span>
          <span>Error</span>
          {errorDetails && (
            <button
              onClick={() => setExpanded(!expanded)}
              style={{
                marginLeft: 'auto',
                background: 'rgba(114, 28, 36, 0.1)',
                border: '1px solid rgba(114, 28, 36, 0.2)',
                borderRadius: '4px',
                color: '#721c24',
                cursor: 'pointer',
                fontSize: '0.8em',
                padding: '2px 8px',
                fontFamily: 'inherit'
              }}
            >
              {expanded ? '▼' : '▶'} Details
            </button>
          )}
        </div>
        <div style={{ fontSize: '0.9em' }}>
          {message.content}
        </div>
        {expanded && errorDetails && (
          <div style={{ marginTop: '0.75em' }}>
            <pre style={{
              background: 'rgba(114, 28, 36, 0.05)',
              borderRadius: '4px',
              padding: '0.75em',
              overflowX: 'auto',
              fontSize: '0.75em',
              lineHeight: '1.4',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontFamily: 'monospace',
              maxHeight: '300px',
              overflowY: 'auto'
            }}>
              {JSON.stringify(errorDetails, null, 2)}
            </pre>
            {errorDetails.status && (
              <div style={{ fontSize: '0.8em', marginTop: '0.5em', opacity: 0.8 }}>
                Status: {errorDetails.status} | Code: {errorDetails.code || 'N/A'}
                {errorDetails.metadata?.retry_after_seconds && (
                  <span> | Retry after: {errorDetails.metadata.retry_after_seconds}s</span>
                )}
                {errorDetails.metadata?.provider_name && (
                  <span> | Provider: {errorDetails.metadata.provider_name}</span>
                )}
              </div>
            )}
          </div>
        )}
        <div style={{
          fontSize: '0.75em',
          opacity: 0.7,
          marginTop: '0.5em',
          textAlign: 'left'
        }}>
          {message.created_at ? new Date(message.created_at).toLocaleTimeString() : ''}
        </div>
      </div>
    </div>
  );
}

function Message({ message, isUser, activeToolIndicators = [], isFocusView = false, currentFocusId = null }) {
  // If it's an error message, use the ErrorMessage component
  if (isErrorMessage(message)) {
    return <ErrorMessage message={message} />;
  }

  // If it's a finish notification (content_filter, empty, etc.), use FinishMessage
  if (isFinishMessage(message)) {
    return <FinishMessage message={message} />;
  }

  // If it's a tool execution message, use the ToolExecution component
  if (isToolMessage(message)) {
    const toolName = message.toolName || message.tool_name;
    
    // Skip if this tool is still represented by an active tool indicator
    // (the indicator will render the live UI and update via socket).
    const isActive = activeToolIndicators.some(
      (t) => t.toolCallId === message.tool_call_id
    );
    if (isActive) {
      return null;
    }

    return (
      <div style={{ marginBottom: '0.75em' }}>
        <ToolExecution
          tool={toolName}
          args={message.toolArgs || message.tool_args}
          result={message.toolResult || message.tool_result}
          status={message.status}
        />
      </div>
    );
  }



  // If it's a system message (e.g., context compressed notification)
  if (message.role === 'system') {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        marginBottom: '0.75em'
      }}>
        <div style={{
          padding: '0.4em 1em',
          borderRadius: '12px',
          backgroundColor: '#e8f5e9',
          border: '1px solid #c8e6c9',
          color: '#2e7d32',
          fontSize: '0.8em',
          textAlign: 'center',
          wordWrap: 'break-word',
          maxWidth: '80%'
        }}>
          {message.content}
        </div>
      </div>
    );
  }

  // If it's an approval request message
  if (isApprovalRequestMessage(message)) {
    return null;
  }

  // If it's an approval response message
  if (isApprovalResponseMessage(message)) {
    const isApproved = message.role === 'approval_approved';
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        marginBottom: '0.75em'
      }}>
        <div style={{
          padding: '0.4em 1em',
          borderRadius: '12px',
          backgroundColor: isApproved ? '#d4edda' : '#f8d7da',
          border: `1px solid ${isApproved ? '#c3e6cb' : '#f5c6cb'}`,
          color: isApproved ? '#155724' : '#721c24',
          fontSize: '0.8em',
          textAlign: 'center',
          wordWrap: 'break-word',
          maxWidth: '80%'
        }}>
          {isApproved ? '✓ ' : '✗ '}{message.content}
        </div>
      </div>
    );
  }

  const [copied, setCopied] = useState(false);
  const content = message.error_message || message.content || '';

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: '1em'
    }}>
      <div style={{
        width: '90%',
        padding: '0.75em',
        borderRadius: '8px',
        backgroundColor: isUser ? '#007bff' : '#f1f1f1',
        color: isUser ? 'white' : 'black',
        wordWrap: 'break-word',
        position: 'relative'
      }}>
        {!isUser && (
          <IconButton
            onClick={handleCopy}
            size="small"
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              color: '#666',
              '&:hover': { color: '#333' }
            }}
          >
            {copied ? <Check fontSize="small" /> : <ContentCopy fontSize="small" />}
          </IconButton>
        )}
        <MessageContent message={message} />
        <div style={{
          fontSize: '0.75em',
          opacity: 0.7,
          marginTop: '0.5em',
          textAlign: isUser ? 'right' : 'left'
        }}>
          {new Date(message.created_at).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}

const MessageList = observer(function MessageList({ messages, isLoading, streamingMessage, toolIndicators, isFocusView = false, currentFocusId = null }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingMessage, toolIndicators]);

  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      padding: '1em',
      display: 'flex',
      flexDirection: 'column'
    }}>
      {messages.map((message) => (
        <Message
          key={message.id}
          message={message}
          isUser={message.role === 'user' && !isErrorMessage(message)}
          activeToolIndicators={toolIndicators}
          isFocusView={isFocusView}
          currentFocusId={currentFocusId}
        />
      ))}

      <ToolIndicator tools={toolIndicators} />

      <StreamingIndicator
        isVisible={isLoading}
        streamingMessage={streamingMessage}
      />

      <div ref={bottomRef} />
    </div>
  );
});

export default MessageList;
