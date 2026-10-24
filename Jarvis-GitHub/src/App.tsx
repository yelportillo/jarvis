import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Box3, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three'
import { Bot, ExternalLink, Eye, EyeOff, Mic, MicOff, Search, Send, Settings as SettingsIcon, Trash2, Upload, X } from 'lucide-react'
import { Canvas } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GCodeLoader } from 'three/examples/jsm/loaders/GCodeLoader.js'
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { VOXLoader } from 'three/examples/jsm/loaders/VOXLoader.js'
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js'
import { VTKLoader } from 'three/examples/jsm/loaders/VTKLoader.js'
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js'

type ModelSearchResult = {
  title: string
  url: string
  description: string
  image?: string
  imageFallback?: string
  source: string
  downloadFormat?: 'STL' | '3MF'
}

type ChatModelSearch = {
  query: string
  results: ModelSearchResult[]
  error?: string
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  sources?: { title: string; url: string }[]
  locationUsed?: boolean
  modelSearch?: ChatModelSearch
}

type UserLocation = {
  latitude: number
  longitude: number
}

type SearchHistoryEntry = {
  query: string
  count: number
  lastSearchedAt: number
}

type PrinterStatus = {
  state: 'checking' | 'connected' | 'not_connected' | 'error'
  ip?: string
  error?: string
}

type SerpApiBalance = {
  state: 'checking' | 'available' | 'error'
  searchesLeft?: number
  extraCredits?: number
  planName?: string
  renewalDate?: string
  error?: string
}

type JarvisSettings = {
  serpApiKey: string
  ollamaUrl: string
  printerIp: string
  displayName: string
}

const BUILD_VOLUME_SCENE_SIZE = 4.5
const BUILD_VOLUME_MM = 220
const BUILD_VOLUME_GRID_DIVISIONS = 11
const VOICE_PAUSE_MS = 1400
const SEARCH_HISTORY_KEY = 'jarvis.model-search-history'
const MAX_SEARCH_HISTORY = 20
const SETTINGS_KEY = 'jarvis.settings'
const DEFAULT_SETTINGS: JarvisSettings = {
  serpApiKey: '',
  ollamaUrl: '',
  printerIp: '',
  displayName: 'JARVIS',
}

type ModelFitState = 'idle' | 'checking' | 'fits' | 'exceeds' | 'unknown'

function loadSettings(): JarvisSettings {
  try {
    const saved = window.localStorage.getItem(SETTINGS_KEY)
    if (!saved) return DEFAULT_SETTINGS
    const parsed: unknown = JSON.parse(saved)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS
    return {
      serpApiKey: 'serpApiKey' in parsed && typeof parsed.serpApiKey === 'string' ? parsed.serpApiKey : DEFAULT_SETTINGS.serpApiKey,
      ollamaUrl: 'ollamaUrl' in parsed && typeof parsed.ollamaUrl === 'string' ? parsed.ollamaUrl : DEFAULT_SETTINGS.ollamaUrl,
      printerIp: 'printerIp' in parsed && typeof parsed.printerIp === 'string' ? parsed.printerIp : DEFAULT_SETTINGS.printerIp,
      displayName: 'displayName' in parsed && typeof parsed.displayName === 'string' ? parsed.displayName : DEFAULT_SETTINGS.displayName,
    }
  } catch (error) {
    console.warn('Could not read JARVIS settings from this browser.', error)
    return DEFAULT_SETTINGS
  }
}

function loadSearchHistory(): SearchHistoryEntry[] {
  try {
    const stored = window.localStorage.getItem(SEARCH_HISTORY_KEY)
    if (!stored) return []
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): SearchHistoryEntry[] => {
      if (
        typeof entry !== 'object'
        || entry === null
        || !('query' in entry)
        || typeof entry.query !== 'string'
        || !('count' in entry)
        || typeof entry.count !== 'number'
        || !('lastSearchedAt' in entry)
        || typeof entry.lastSearchedAt !== 'number'
      ) return []
      return [{ query: entry.query, count: entry.count, lastSearchedAt: entry.lastSearchedAt }]
    }).slice(0, MAX_SEARCH_HISTORY)
  } catch (error) {
    console.warn('Could not read JARVIS search history from this browser.', error)
    return []
  }
}

function needsCurrentLocation(message: string): boolean {
  return /\b(?:is|are|was|were)\b.{0,120}\bopen\b/i.test(message)
    || /\b(?:near me|nearby|around here|in my area|closest|nearest|local store|store hours|opening hours|business hours|weather|forecast|traffic)\b/i.test(message)
}

function getCurrentLocation(): Promise<UserLocation> {
  if (!navigator.geolocation) {
    return Promise.reject(new Error('Location is not available in this browser. Please include your city or ZIP code.'))
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
      (error) => {
        const message = error.code === error.PERMISSION_DENIED
          ? 'Location permission was denied. Allow location access or include your city or ZIP code.'
          : error.code === error.TIMEOUT
            ? 'Could not get your location in time. Try again or include your city or ZIP code.'
            : 'Could not get your location. Try again or include your city or ZIP code.'
        reject(new Error(message))
      },
      { enableHighAccuracy: false, maximumAge: 300_000, timeout: 10_000 },
    )
  })
}

function App() {
  const [settings, setSettings] = useState<JarvisSettings>(loadSettings)
  const [settingsDraft, setSettingsDraft] = useState<JarvisSettings>(settings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState('')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'relevance' | 'trending'>('relevance')
  const [modelSearchTerms, setModelSearchTerms] = useState('')
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>(loadSearchHistory)
  const [modelResults, setModelResults] = useState<ModelSearchResult[]>([])
  const [modelSearchState, setModelSearchState] = useState<'idle' | 'loading' | 'complete' | 'error'>('idle')
  const [modelSearchError, setModelSearchError] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatDraft, setChatDraft] = useState('')
  const [chatPending, setChatPending] = useState(false)
  const [chatError, setChatError] = useState('')
  const [chatVoiceActive, setChatVoiceActive] = useState(false)
  const [chatVoiceStatus, setChatVoiceStatus] = useState('')
  const [listening, setListening] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState('')
  const [modelFile, setModelFile] = useState<File | null>(null)
  const [modelFitState, setModelFitState] = useState<ModelFitState>('idle')
  const [printerStatus, setPrinterStatus] = useState<PrinterStatus>({ state: 'checking' })
  const [serpApiBalance, setSerpApiBalance] = useState<SerpApiBalance>({ state: 'checking' })
  const recognitionRef = useRef<any>(null)
  const chatRecognitionRef = useRef<any>(null)
  const chatVoiceActiveRef = useRef(false)
  const chatSpeakingRef = useRef(false)
  const chatStopCommandRef = useRef(false)
  const chatSpeechInterruptedRef = useRef(false)
  const chatVoiceTurnPendingRef = useRef(false)
  const chatVoiceTranscriptRef = useRef('')
  const chatVoiceSegmentsRef = useRef<string[]>([])
  const chatVoicePauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatPendingRef = useRef(chatPending)
  const chatMessagesRef = useRef(chatMessages)
  const chatHistoryRef = useRef<HTMLDivElement>(null)
  chatPendingRef.current = chatPending
  chatMessagesRef.current = chatMessages

  useEffect(() => {
    const history = chatHistoryRef.current
    if (history) history.scrollTo({ top: history.scrollHeight, behavior: 'smooth' })
  }, [chatError, chatMessages, chatPending])

  useEffect(() => {
    let active = true
    const checkPrinterStatus = async () => {
      try {
        const params = new URLSearchParams({ ip: settings.printerIp })
        const response = await fetch(`/api/printer/status?${params}`, { cache: 'no-store' })
        const payload = await response.json() as { error?: string; ip?: string; status?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Printer status is unavailable.')
        if (payload.status !== 'connected' && payload.status !== 'not_connected') {
          throw new Error('Printer status endpoint returned an invalid status.')
        }
        if (active) setPrinterStatus({ state: payload.status, ip: payload.ip })
      } catch (error) {
        if (active) {
          setPrinterStatus({
            state: 'error',
            error: error instanceof Error ? error.message : 'Printer status is unavailable.',
          })
        }
      }
    }

    void checkPrinterStatus()
    const interval = window.setInterval(() => void checkPrinterStatus(), 15_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [settings.printerIp])

  useEffect(() => {
    let active = true
    const checkSerpApiBalance = async () => {
      try {
        const response = await fetch('/api/serpapi/account', {
          cache: 'no-store',
          headers: { 'x-jarvis-serpapi-key': settings.serpApiKey },
        })
        const payload = await response.json() as {
          error?: string
          searchesLeft?: number
          extraCredits?: number
          planName?: string
          renewalDate?: string
        }
        if (!response.ok) throw new Error(payload.error ?? 'SerpApi balance is unavailable.')
        if (typeof payload.searchesLeft !== 'number' || !Number.isFinite(payload.searchesLeft)) {
          throw new Error('SerpApi returned an invalid remaining search balance.')
        }
        if (active) {
          setSerpApiBalance({
            state: 'available',
            searchesLeft: payload.searchesLeft,
            extraCredits: payload.extraCredits,
            planName: payload.planName,
            renewalDate: payload.renewalDate,
          })
        }
      } catch (error) {
        if (active) {
          setSerpApiBalance({
            state: 'error',
            error: error instanceof Error ? error.message : 'SerpApi balance is unavailable.',
          })
        }
      }
    }

    void checkSerpApiBalance()
    const interval = window.setInterval(() => void checkSerpApiBalance(), 300_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [settings.serpApiKey])

  useEffect(() => () => {
    chatVoiceActiveRef.current = false
    if (chatVoicePauseTimerRef.current) clearTimeout(chatVoicePauseTimerRef.current)
    chatRecognitionRef.current?.abort()
    window.speechSynthesis?.cancel()
  }, [])

  const handleModelUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setModelFile(file)
    setModelFitState('checking')
    event.target.value = ''
  }

  const search = async (value: string, mode = searchMode) => {
    const term = value.trim()
    if (!term) {
      setSubmittedQuery('')
      setModelResults([])
      setModelSearchState('idle')
      setModelSearchError('')
      setVoiceStatus('Enter a model or describe what you want to print.')
      return
    }
    setQuery(term)
    setSubmittedQuery(term)
    setModelSearchTerms('')
    const now = Date.now()
    const existingEntry = searchHistory.find((entry) => entry.query.toLowerCase() === term.toLowerCase())
    const nextHistory = [
      { query: term, count: (existingEntry?.count ?? 0) + 1, lastSearchedAt: now },
      ...searchHistory.filter((entry) => entry.query.toLowerCase() !== term.toLowerCase()),
    ].slice(0, MAX_SEARCH_HISTORY)
    setSearchHistory(nextHistory)
    try {
      window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(nextHistory))
    } catch (error) {
      console.warn('Could not save JARVIS search history in this browser.', error)
    }
    setVoiceStatus('')
    setModelResults([])
    setModelSearchError('')
    setModelSearchState('loading')

    try {
      const params = new URLSearchParams({ q: term, sort: mode })
      params.set('ollama', 'true')
      const response = await fetch(`/api/model-search?${params}`, {
        cache: 'no-store',
        headers: {
          'x-jarvis-serpapi-key': settings.serpApiKey,
          'x-jarvis-ollama-url': settings.ollamaUrl,
        },
      })
      const payload = await response.json() as { error?: string; results?: ModelSearchResult[]; searchTerms?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Model search failed. Try again.')

      setModelSearchTerms(payload.searchTerms ?? '')
      setModelResults(payload.results ?? [])
      setModelSearchState('complete')
    } catch (error) {
      setModelSearchError(error instanceof Error ? error.message : 'Model search failed. Try again.')
      setModelSearchState('error')
    }
  }

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    search(query)
  }

  const recommendations = [...searchHistory]
    .filter((entry) => entry.query.toLowerCase() !== query.trim().toLowerCase())
    .sort((first, second) => second.count - first.count || second.lastSearchedAt - first.lastSearchedAt)
    .slice(0, 5)

  const clearSearchHistory = () => {
    try {
      window.localStorage.removeItem(SEARCH_HISTORY_KEY)
      setSearchHistory([])
    } catch (error) {
      console.warn('Could not clear JARVIS search history from this browser.', error)
      setVoiceStatus('Could not clear search history from this browser.')
    }
  }

  const openSettings = () => {
    setSettingsDraft(settings)
    setSettingsMessage('')
    setSettingsOpen(true)
  }

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const displayName = settingsDraft.displayName.trim()
    if (!displayName) {
      setSettingsMessage('Enter a name for JARVIS.')
      return
    }

    let ollamaUrl = ''
    if (settingsDraft.ollamaUrl.trim()) {
      try {
        const parsedUrl = new URL(settingsDraft.ollamaUrl)
        const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '')
        const isLoopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
        if (
          (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
          || parsedUrl.username
          || parsedUrl.password
          || !isLoopback
        ) {
          setSettingsMessage('Use a local Ollama address, such as http://127.0.0.1:11434.')
          return
        }
        ollamaUrl = parsedUrl.origin
      } catch {
        setSettingsMessage('Enter a valid Ollama URL, such as http://127.0.0.1:11434.')
        return
      }
    }

    const nextSettings = { ...settingsDraft, ollamaUrl, printerIp: settingsDraft.printerIp.trim(), displayName }
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings))
      setSettings(nextSettings)
      setSettingsDraft(nextSettings)
      setSettingsMessage('Settings saved.')
    } catch (error) {
      console.warn('Could not save JARVIS settings in this browser.', error)
      setSettingsMessage('Could not save settings in this browser.')
    }
  }

  const changeSearchMode = (mode: 'relevance' | 'trending') => {
    setSearchMode(mode)
    if (submittedQuery) void search(submittedQuery, mode)
  }

  function startChatRecognition() {
    if (
      !chatVoiceActiveRef.current
      || (chatPendingRef.current && !chatSpeakingRef.current)
      || chatRecognitionRef.current
    ) return

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      chatVoiceActiveRef.current = false
      setChatVoiceActive(false)
      setChatVoiceStatus('Voice input is not supported in this browser. Try Chrome or Edge, or type your message.')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'en-US'
    recognition.continuous = true
    recognition.interimResults = true
    chatVoiceSegmentsRef.current = []
    chatVoiceTranscriptRef.current = ''
    recognition.onstart = () => {
      setChatVoiceStatus(chatSpeakingRef.current
        ? 'JARVIS is speaking. Say “stop” to interrupt.'
        : 'Listening… pause briefly to send your message. Tap the microphone to stop.')
    }
    recognition.onresult = (event: any) => {
      const changedResultIndex = typeof event.resultIndex === 'number' ? event.resultIndex : 0
      for (let index = changedResultIndex; index < event.results.length; index += 1) {
        chatVoiceSegmentsRef.current[index] = event.results[index][0]?.transcript ?? ''
      }
      chatVoiceSegmentsRef.current.length = event.results.length
      const transcript = chatVoiceSegmentsRef.current
        .join(' ')
        .trim()
      if (!transcript) return

      if (chatSpeakingRef.current) {
        const stopCommand = /\b(?:stop(?:\s+(?:talking|speaking|now|jarvis))?|jarvis\s+stop|be\s+quiet|quiet)\b/i
        if (stopCommand.test(transcript)) {
          chatSpeakingRef.current = false
          chatSpeechInterruptedRef.current = true
          chatStopCommandRef.current = true
          chatVoiceTurnPendingRef.current = false
          chatVoiceTranscriptRef.current = ''
          chatVoiceSegmentsRef.current = []
          setChatDraft('')
          setChatVoiceStatus('JARVIS stopped. Listening…')
          window.speechSynthesis.cancel()
          recognition.stop()
        }
        return
      }

      if (chatStopCommandRef.current) return
      chatVoiceTranscriptRef.current = transcript
      setChatDraft(transcript)
      if (chatVoiceTurnPendingRef.current) return
      if (chatVoicePauseTimerRef.current) clearTimeout(chatVoicePauseTimerRef.current)
      chatVoicePauseTimerRef.current = setTimeout(() => {
        chatVoicePauseTimerRef.current = null
        chatVoiceTurnPendingRef.current = true
        chatRecognitionRef.current?.stop()
      }, VOICE_PAUSE_MS)
    }
    recognition.onerror = (event: { error?: string }) => {
      const messages: Record<string, string> = {
        'not-allowed': 'Microphone access is blocked. Allow access in your browser settings and try again.',
        'service-not-allowed': 'Speech recognition is blocked by the browser. Try another browser or type your message.',
        'audio-capture': 'No system microphone was found. Connect or enable one and try again.',
        'no-speech': 'Listening… pause briefly to send your message.',
      }
      const error = event.error ?? ''
      setChatVoiceStatus(messages[error] ?? 'Voice input failed. Check your microphone and browser permissions.')
      if (error !== 'no-speech') {
        chatVoiceActiveRef.current = false
        setChatVoiceActive(false)
      }
    }
    recognition.onend = () => {
      if (chatRecognitionRef.current === recognition) chatRecognitionRef.current = null
      const stoppedSpeaking = chatStopCommandRef.current
      chatStopCommandRef.current = false
      if (chatVoicePauseTimerRef.current) {
        clearTimeout(chatVoicePauseTimerRef.current)
        chatVoicePauseTimerRef.current = null
      }

      if (stoppedSpeaking) {
        chatVoiceTranscriptRef.current = ''
        chatVoiceSegmentsRef.current = []
        if (chatVoiceActiveRef.current) {
          window.setTimeout(startChatRecognition, 250)
        }
        return
      }

      if (chatVoiceTurnPendingRef.current) {
        chatVoiceTurnPendingRef.current = false
        const transcript = chatVoiceTranscriptRef.current.trim()
        chatVoiceTranscriptRef.current = ''
        if (transcript) {
          void sendChatMessage(transcript, true)
          return
        }
      }

      if (chatVoiceActiveRef.current) {
        window.setTimeout(startChatRecognition, 250)
      }
    }

    chatRecognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      chatRecognitionRef.current = null
      chatVoiceActiveRef.current = false
      setChatVoiceActive(false)
      setChatVoiceStatus('Could not start the microphone. Check your browser permissions and try again.')
    }
  }

  function resumeChatVoice() {
    if (!chatVoiceActiveRef.current) return
    if (chatSpeechInterruptedRef.current) return
    setChatVoiceStatus(`${settings.displayName} is ready. Listening again…`)
    window.setTimeout(startChatRecognition, 250)
  }

  async function sendChatMessage(message: string, spoken = false) {
    const content = message.trim()
    if (!content || chatPendingRef.current) return

    const nextMessages = [...chatMessagesRef.current, { role: 'user' as const, content }]
    const contextMessages = nextMessages.slice(-20)
    while (contextMessages.reduce((total, message) => total + message.content.length, 0) > 40_000) {
      contextMessages.shift()
    }
    chatMessagesRef.current = nextMessages
    setChatMessages(nextMessages)
    setChatDraft('')
    chatPendingRef.current = true
    setChatPending(true)
    setChatError('')
    const useCurrentLocation = needsCurrentLocation(content)
    setChatVoiceStatus(useCurrentLocation
      ? 'Getting your current location for a nearby search…'
      : spoken ? `${settings.displayName} is listening for its reply…` : '')

    try {
      const location = useCurrentLocation ? await getCurrentLocation() : undefined
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-jarvis-serpapi-key': settings.serpApiKey,
          'x-jarvis-ollama-url': settings.ollamaUrl,
        },
        body: JSON.stringify({ messages: contextMessages, location }),
      })
      const payload = await response.json() as {
        error?: string
        reply?: string
        sources?: { title: string; url: string }[]
        locationUsed?: boolean
        modelSearchQuery?: string
      }
      if (!response.ok) throw new Error(payload.error ?? 'The assistant could not reply. Try again.')
      if (!payload.reply) throw new Error('Ollama returned an empty reply. Try again.')

      let modelSearch: ChatModelSearch | undefined
      if (payload.modelSearchQuery) {
        try {
          const params = new URLSearchParams({
            q: payload.modelSearchQuery,
            sort: searchMode,
          })
          const modelResponse = await fetch(`/api/model-search?${params}`, {
            cache: 'no-store',
            headers: {
              'x-jarvis-serpapi-key': settings.serpApiKey,
              'x-jarvis-ollama-url': settings.ollamaUrl,
            },
          })
          const modelPayload = await modelResponse.json() as {
            error?: string
            results?: ModelSearchResult[]
          }
          if (!modelResponse.ok) throw new Error(modelPayload.error ?? 'Model search failed. Try again.')
          modelSearch = {
            query: payload.modelSearchQuery,
            results: modelPayload.results ?? [],
          }
        } catch (error) {
          modelSearch = {
            query: payload.modelSearchQuery,
            results: [],
            error: error instanceof Error ? error.message : 'Model search failed. Try again.',
          }
        }
      }

      const completedMessages = [
        ...nextMessages,
        {
          role: 'assistant' as const,
          content: payload.reply,
          sources: payload.sources,
          locationUsed: payload.locationUsed,
          modelSearch,
        },
      ]
      chatMessagesRef.current = completedMessages
      setChatMessages(completedMessages)
      if (spoken) {
        if ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) {
          window.speechSynthesis.cancel()
          chatSpeechInterruptedRef.current = false
          const utterance = new SpeechSynthesisUtterance(payload.reply)
          utterance.onstart = () => {
            chatSpeakingRef.current = true
            setChatVoiceStatus(`${settings.displayName} is speaking… Say “stop” to interrupt.`)
            startChatRecognition()
          }
          utterance.onend = () => {
            chatSpeakingRef.current = false
            if (!chatSpeechInterruptedRef.current) resumeChatVoice()
          }
          utterance.onerror = () => {
            chatSpeakingRef.current = false
            if (chatSpeechInterruptedRef.current) return
            setChatVoiceStatus('Reply received. Speech playback was unavailable.')
            resumeChatVoice()
          }
          window.speechSynthesis.speak(utterance)
        } else {
          setChatVoiceStatus('Reply received. Speech playback is not supported in this browser.')
          resumeChatVoice()
        }
      }
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'The assistant could not reply. Try again.')
      setChatVoiceStatus('')
      if (spoken) resumeChatVoice()
    } finally {
      chatPendingRef.current = false
      setChatPending(false)
    }
  }

  const submitChatForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void sendChatMessage(chatDraft)
  }

  const toggleChatVoice = () => {
    if (chatVoiceActiveRef.current) {
      chatVoiceActiveRef.current = false
      chatSpeakingRef.current = false
      chatSpeechInterruptedRef.current = false
      setChatVoiceActive(false)
      window.speechSynthesis?.cancel()
      if (chatVoicePauseTimerRef.current) {
        clearTimeout(chatVoicePauseTimerRef.current)
        chatVoicePauseTimerRef.current = null
      }
      const transcript = chatVoiceTranscriptRef.current.trim()
      chatVoiceTranscriptRef.current = ''
      if (transcript && chatRecognitionRef.current) {
        chatVoiceTurnPendingRef.current = true
        chatRecognitionRef.current.stop()
      } else {
        chatRecognitionRef.current?.stop()
      }
      setChatVoiceStatus('')
      return
    }

    if (chatPendingRef.current) return
    chatVoiceActiveRef.current = true
    chatVoiceTurnPendingRef.current = false
    chatVoiceTranscriptRef.current = ''
    chatVoiceSegmentsRef.current = []
    setChatVoiceActive(true)
    setChatVoiceStatus('Starting microphone…')
    startChatRecognition()
  }

  const clearChat = () => {
    chatVoiceActiveRef.current = false
    chatSpeakingRef.current = false
    chatStopCommandRef.current = false
    chatSpeechInterruptedRef.current = false
    chatVoiceTurnPendingRef.current = false
    chatVoiceTranscriptRef.current = ''
    if (chatVoicePauseTimerRef.current) {
      clearTimeout(chatVoicePauseTimerRef.current)
      chatVoicePauseTimerRef.current = null
    }
    chatRecognitionRef.current?.abort()
    chatRecognitionRef.current = null
    setChatVoiceActive(false)
    setChatMessages([])
    chatMessagesRef.current = []
    setChatError('')
    setChatVoiceStatus('')
    window.speechSynthesis?.cancel()
  }

  const toggleVoice = () => {
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

    if (!SpeechRecognition) {
      setVoiceStatus('Voice search is not supported in this browser. Try Chrome or Edge, or type your search.')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'en-US'
    recognition.continuous = false
    recognition.interimResults = false
    recognition.onstart = () => {
      setListening(true)
      setVoiceStatus('Listening through your system microphone…')
    }
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript
      setQuery(transcript)
      search(transcript)
    }
    recognition.onerror = (event: { error?: string }) => {
      const messages: Record<string, string> = {
        'not-allowed': 'Microphone access is blocked. Allow access in your browser settings and try again.',
        'service-not-allowed': 'Speech recognition is blocked by the browser. Try another browser or type your search.',
        'audio-capture': 'No system microphone was found. Connect or enable one and try again.',
        'no-speech': 'No speech was detected. Try again or type your search.',
      }
      setVoiceStatus(messages[event.error ?? ''] ?? 'Voice input failed. Check your microphone and browser permissions.')
      setListening(false)
    }
    recognition.onend = () => setListening(false)

    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      setListening(false)
      setVoiceStatus('Could not start the system microphone. Check your browser permissions and try again.')
    }
  }

  return (
    <main className="search-page">
      <header className="brand-lockup" aria-label={`${settings.displayName} model search`}>
        <div className="brand-mark" aria-hidden="true">J</div>
        <div>
          <p className="brand-kicker">PERSONAL AI ASSISTANT</p>
          <h1>{settings.displayName}</h1>
        </div>
        <div
          className={`printer-status ${printerStatus.state}`}
          role="status"
          aria-live="polite"
          title={printerStatus.error ?? `Ping status for ${printerStatus.ip ?? 'configured printer'}`}
        >
          <span className="printer-status-indicator" aria-hidden="true" />
          <span>
            Printer · {printerStatus.state === 'checking'
              ? 'Checking…'
              : printerStatus.state === 'connected'
                ? 'Connected'
                : printerStatus.state === 'not_connected'
                  ? 'Not connected'
                  : 'Status unavailable'}
          </span>
        </div>
        <div
          className={`serpapi-balance ${serpApiBalance.state}`}
          role="status"
          aria-live="polite"
          title={[
            serpApiBalance.error,
            serpApiBalance.planName,
            serpApiBalance.renewalDate ? `Renews ${serpApiBalance.renewalDate}` : '',
            typeof serpApiBalance.extraCredits === 'number' ? `${serpApiBalance.extraCredits} extra credits` : '',
          ].filter(Boolean).join(' · ')}
        >
          <span className="serpapi-balance-indicator" aria-hidden="true" />
          <span>
            SerpApi · {serpApiBalance.state === 'checking'
              ? 'Checking…'
              : serpApiBalance.state === 'available'
                ? `${serpApiBalance.searchesLeft?.toLocaleString()} searches left`
                : 'Balance unavailable'}
          </span>
        </div>
        <button className="settings-open" type="button" onClick={openSettings} aria-label="Open settings">
          <SettingsIcon size={17} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </header>
      {settingsOpen && (
        <div className="settings-backdrop">
          <section className="settings-page" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
            <header className="settings-header">
              <div>
                <p className="section-kicker">PREFERENCES</p>
                <h2 id="settings-heading">{settings.displayName} settings</h2>
              </div>
              <button type="button" className="settings-close" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            <form className="settings-form" onSubmit={saveSettings}>
              <label className="settings-field">
                <span>Display name</span>
                <input
                  value={settingsDraft.displayName}
                  maxLength={40}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, displayName: event.target.value })}
                  autoComplete="off"
                />
              </label>
              <label className="settings-field">
                <span>SerpApi API key</span>
                <span className="settings-secret-input">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={settingsDraft.serpApiKey}
                    onChange={(event) => setSettingsDraft({ ...settingsDraft, serpApiKey: event.target.value })}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((visible) => !visible)}
                    aria-label={showApiKey ? 'Hide SerpApi key' : 'Show SerpApi key'}
                    aria-pressed={showApiKey}
                  >
                    {showApiKey ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                  </button>
                </span>
                <small>Stored in this browser. Sent only to the local JARVIS server for SerpApi requests.</small>
              </label>
              <label className="settings-field">
                <span>Ollama server URL</span>
                <input
                  type="url"
                  value={settingsDraft.ollamaUrl}
                  placeholder="http://127.0.0.1:11434"
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, ollamaUrl: event.target.value })}
                  autoComplete="url"
                />
                <small>Leave blank to use the server’s .env.local setting. Use a local address only.</small>
              </label>
              <label className="settings-field">
                <span>Printer IP address</span>
                <input
                  value={settingsDraft.printerIp}
                  placeholder="Use server default"
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, printerIp: event.target.value })}
                  autoComplete="off"
                />
              </label>
              <label className="settings-field">
                <span>JARVIS web port</span>
                <input value="8050" readOnly disabled />
                <small>Change the Vite port in vite.config.ts and restart the server.</small>
              </label>
              <p className="settings-storage-note">Settings are saved in this browser only. The API key is masked by default; use the eye button to reveal it.</p>
              {settingsMessage && <p className="settings-message" role="status">{settingsMessage}</p>}
              <div className="settings-actions">
                <button className="settings-save" type="submit">Save settings</button>
                <button className="settings-done" type="button" onClick={() => setSettingsOpen(false)}>Done</button>
              </div>
            </form>
          </section>
        </div>
      )}

      <section className="search-content" aria-labelledby="search-heading">
        <p className="section-kicker">MODEL DISCOVERY</p>
        <h2 id="search-heading">What are you looking for?</h2>
        <form className="search-form" onSubmit={submitSearch}>
          <div className="search-field">
            <Search size={19} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search printable models"
              placeholder="Try “iphone case” or “desk organizer”"
            />
            <button
              type="button"
              className={listening ? 'voice-button listening' : 'voice-button'}
              onClick={toggleVoice}
              aria-label={listening ? 'Stop voice search' : 'Start voice search'}
              aria-pressed={listening}
              title="Voice search uses your system microphone"
            >
              {listening ? <MicOff size={19} /> : <Mic size={19} />}
            </button>
          </div>
          <button className="search-button" type="submit">
            <Search size={16} aria-hidden="true" />
            Search models
          </button>
        </form>
        <div className="search-options" aria-label="Model search sorting">
          <button
            type="button"
            className={`search-option ${searchMode === 'relevance' ? 'selected' : ''}`}
            aria-pressed={searchMode === 'relevance'}
            onClick={() => changeSearchMode('relevance')}
          >
            Most relevant
          </button>
          <button
            type="button"
            className={`search-option ${searchMode === 'trending' ? 'selected' : ''}`}
            aria-pressed={searchMode === 'trending'}
            onClick={() => changeSearchMode('trending')}
          >
            Trending · 30 days
          </button>
        </div>
        {searchHistory.length > 0 && (
          <div className="search-recommendations" aria-label="Recommended searches based on your history">
            <div className="search-recommendations-heading">
              <p className="section-kicker">BASED ON YOUR SEARCHES</p>
              <button className="clear-search-history" type="button" onClick={clearSearchHistory}>
                <Trash2 size={12} aria-hidden="true" />
                Clear history
              </button>
            </div>
            {recommendations.length > 0 && (
              <div className="recommendation-list">
                {recommendations.map((entry) => (
                  <button
                    className="recommendation-chip"
                    key={entry.query}
                    type="button"
                    onClick={() => {
                      setQuery(entry.query)
                      void search(entry.query)
                    }}
                  >
                    {entry.query}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="search-note" role="status">
          {voiceStatus || (listening
            ? 'Listening through your system microphone…'
            : 'Ollama interprets every request, then JARVIS searches trusted model libraries on the web.')}
        </p>

        <section className="hyperspace" aria-label="3D Hyperspace visualization">
          <div className="hyperspace-heading">
            <p className="section-kicker">3D HYPERSPACE</p>
            <div className="hyperspace-tools">
              {modelFile && <span className="uploaded-name" title={modelFile.name}>{modelFile.name}</span>}
              <label className="upload-button">
                <Upload size={15} aria-hidden="true" />
                Open 3D model
                <input
                  type="file"
                  aria-label="Open a 3D model"
                  onChange={handleModelUpload}
                />
              </label>
            </div>
          </div>
          <div className="hyperspace-canvas">
            <Canvas camera={{ position: [0, 0, 8], fov: 42 }}>
              <color attach="background" args={['#07131b']} />
              <ambientLight intensity={0.55} />
              <pointLight position={[4, 3, 5]} intensity={24} color="#75b7ff" />
              <pointLight position={[-4, -2, -3]} intensity={12} color="#efb577" />
              <group rotation={[0.3, -0.35, 0]}>
                <BuildVolumeGrid />
                {modelFile ? (
                  <UploadedModelPreview
                    file={modelFile}
                    onFitCheck={setModelFitState}
                  />
                ) : (
                  <mesh>
                    <torusKnotGeometry args={[1.65, 0.48, 220, 32, 2, 5]} />
                    <meshStandardMaterial color="#75b7ff" emissive="#164d91" emissiveIntensity={0.7} roughness={0.3} metalness={0.35} />
                  </mesh>
                )}
              </group>
              <OrbitControls enablePan={false} enableZoom enableRotate autoRotate autoRotateSpeed={0.35} />
            </Canvas>
            <div className="build-volume-label">
              BUILD VOLUME · {BUILD_VOLUME_MM} × {BUILD_VOLUME_MM} × {BUILD_VOLUME_MM} MM
            </div>
            <div className={`model-fit-status ${modelFitState}`} role="status" aria-live="polite">
              {modelFitState === 'idle' && 'UPLOAD MODEL TO CHECK FIT'}
              {modelFitState === 'checking' && 'CHECKING MODEL SIZE…'}
              {modelFitState === 'fits' && 'FITS · MILLIMETERS ASSUMED'}
              {modelFitState === 'exceeds' && 'EXCEEDS VOLUME · MILLIMETERS ASSUMED'}
              {modelFitState === 'unknown' && 'FIT UNKNOWN · CHECK FILE UNITS'}
            </div>
            <div className="hyperspace-caption">{modelFile ? modelFile.name : 'Interactive 3D space'}</div>
          </div>
        </section>

        {submittedQuery && (
          <section className="source-results" aria-live="polite" aria-labelledby="results-heading">
            <div className="results-heading">
              <div>
                <p className="section-kicker">
                  {searchMode === 'trending' ? 'TRENDING · PAST 30 DAYS' : 'MOST RELEVANT · TRUSTED 3D SOURCES'}
                </p>
                <h3 id="results-heading">Search for “{submittedQuery}”</h3>
                {modelSearchTerms && (
                  <p className="model-search-terms">Ollama search terms: {modelSearchTerms}</p>
                )}
              </div>
                {modelSearchState === 'complete' && (
                  <span className="result-count">{modelResults.length} results</span>
                )}
              </div>
              {modelSearchState === 'loading' && (
                <p className="model-search-message" role="status">Searching model libraries…</p>
              )}
              {modelSearchState === 'error' && (
                <p className="model-search-message model-search-error" role="alert">{modelSearchError}</p>
              )}
              {modelSearchState === 'complete' && modelResults.length === 0 && (
                <p className="model-search-message" role="status">No matching models found. Try a different search.</p>
              )}
              {modelSearchState === 'complete' && modelResults.length > 0 && (
                <>
                  <div className="model-results-grid">
                    {modelResults.map((result) => (
                      <article
                        className="model-result-card"
                        key={result.url}
                      >
                        <ModelResultImage
                          key={`${result.url}:${result.image ?? ''}:${result.imageFallback ?? ''}`}
                          title={result.title}
                          image={result.image}
                          fallback={result.imageFallback}
                          eager
                        />
                        <div className="model-result-copy">
                          <small className="model-result-source">{result.source}</small>
                          <strong>{result.title}</strong>
                          {result.description && <p>{result.description}</p>}
                          <a className="model-result-cta" href={result.url} target="_blank" rel="noreferrer">
                            Open source <ExternalLink size={13} aria-hidden="true" />
                          </a>
                          {result.downloadFormat && (
                            <a
                              className="model-result-cta download-result-cta"
                              href={result.url}
                              download
                              target="_blank"
                              rel="noreferrer"
                            >
                              Download {result.downloadFormat}
                            </a>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                  <p className="source-disclaimer">Search results are shown here; open a model to view its details or download it from the source.</p>
                </>
              )}
            </section>
          )}
      </section>
      <section className="assistant-panel" aria-labelledby="assistant-heading">
        <div className="assistant-header">
          <div className="assistant-title">
            <span className="assistant-icon"><Bot size={18} aria-hidden="true" /></span>
            <div>
              <p className="section-kicker">LOCAL AI · OLLAMA</p>
              <h2 id="assistant-heading">Talk to {settings.displayName}</h2>
            </div>
          </div>
          <button
            className="assistant-clear"
            type="button"
            onClick={clearChat}
            disabled={chatPending || chatMessages.length === 0}
          >
            <Trash2 size={14} aria-hidden="true" />
            Clear chat
          </button>
        </div>
        <div className="assistant-history" aria-live="polite" ref={chatHistoryRef}>
          {chatMessages.length === 0 && (
            <div className="assistant-welcome">
              <strong>What can I help you with?</strong>
              <span>Ask a question, get ideas, or talk through a 3D printing project.</span>
            </div>
          )}
          {chatMessages.map((message, index) => (
            <div className={`assistant-message ${message.role}`} key={`${message.role}-${index}`}>
              <span className="assistant-message-label">{message.role === 'user' ? 'YOU' : settings.displayName}</span>
              <p>{message.content}</p>
              {message.locationUsed && <span className="assistant-location-note">Searched near your current location</span>}
              {message.modelSearch && (
                <section className="assistant-model-search" aria-label="3D model search results">
                  <div className="assistant-model-search-heading">
                    <strong>3D MODELS · {message.modelSearch.query}</strong>
                  </div>
                  {message.modelSearch.error ? (
                    <p className="assistant-model-search-message" role="alert">{message.modelSearch.error}</p>
                  ) : message.modelSearch.results.length === 0 ? (
                    <p className="assistant-model-search-message">No matching models found. Try refining your request.</p>
                  ) : (
                    <div className="assistant-model-list">
                      {getChatModelResults(message.modelSearch.results).map((result) => (
                        <article className="assistant-model-result" key={result.url}>
                          <ModelResultImage
                            key={`${result.url}:${result.image ?? ''}:${result.imageFallback ?? ''}`}
                            title={result.title}
                            image={result.image}
                            fallback={result.imageFallback}
                          />
                          <div className="assistant-model-result-copy">
                            <small>{result.source}</small>
                            <strong>{result.title}</strong>
                            <a href={result.url} target="_blank" rel="noreferrer">
                              Open model <ExternalLink size={11} aria-hidden="true" />
                            </a>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {message.sources && message.sources.length > 0 && (
                <nav className="assistant-sources" aria-label="Web sources">
                  <span>WEB SOURCES</span>
                  {message.sources.map((source, sourceIndex) => (
                    <a href={source.url} key={source.url} target="_blank" rel="noreferrer">
                      [{sourceIndex + 1}] {source.title} <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  ))}
                </nav>
              )}
            </div>
          ))}
          {chatPending && (
            <div className="assistant-message assistant">
              <span className="assistant-message-label">{settings.displayName}</span>
              <p className="assistant-thinking" role="status">Thinking with Ollama…</p>
            </div>
          )}
          {chatError && <p className="assistant-error" role="alert">{chatError}</p>}
        </div>
        <form className="assistant-form" onSubmit={submitChatForm}>
          <textarea
            value={chatDraft}
            onChange={(event) => setChatDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            maxLength={8000}
            placeholder={`Ask ${settings.displayName} anything…`}
            aria-label={`Message ${settings.displayName}`}
            rows={2}
            disabled={chatPending}
          />
          <button
            className={`assistant-mic ${chatVoiceActive ? 'listening' : ''}`}
            type="button"
            onClick={toggleChatVoice}
            disabled={!chatVoiceActive && chatPending}
            aria-label={chatVoiceActive ? 'Stop voice conversation' : 'Start voice conversation'}
            aria-pressed={chatVoiceActive}
            title={chatVoiceActive ? 'Stop voice conversation' : 'Start continuous voice conversation'}
          >
            {chatVoiceActive ? <MicOff size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
          </button>
          <button className="assistant-send" type="submit" disabled={chatPending || !chatDraft.trim()}>
            <Send size={16} aria-hidden="true" />
            <span>{chatPending ? 'Thinking…' : 'Send'}</span>
          </button>
        </form>
        {chatVoiceStatus && <p className="assistant-voice-status" role="status">{chatVoiceStatus}</p>}
        <p className="assistant-footnote">Runs on your local Ollama model · Current questions use web search when configured · Voice mode sends after a short pause</p>
      </section>
      <footer className="page-footer">Search across 3D-print model libraries</footer>
    </main>
  )
}

export default App

function ModelResultImage({
  title,
  image,
  fallback,
  eager = false,
}: {
  title: string
  image?: string
  fallback?: string
  eager?: boolean
}) {
  const [failedImages, setFailedImages] = useState<string[]>([])
  const imageUrl = [image, fallback].find((candidate) => candidate && !failedImages.includes(candidate))
  const src = imageUrl ?? createFallbackThumbnail(title)

  return (
    <div className="model-result-art">
      <img
        src={src}
        alt={imageUrl ? `${title} model thumbnail` : `Generated preview for ${title}; source thumbnail unavailable`}
        loading={eager ? 'eager' : 'lazy'}
        onError={() => {
          if (imageUrl) setFailedImages((failed) => [...failed, imageUrl])
        }}
      />
    </div>
  )
}

function createFallbackThumbnail(title: string): string {
  const escapedTitle = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
  const displayTitle = escapedTitle.length > 38 ? `${escapedTitle.slice(0, 35)}...` : escapedTitle
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#14283a"/><stop offset="1" stop-color="#0b141d"/></linearGradient></defs>
    <rect width="640" height="400" fill="url(#bg)"/>
    <path d="M0 320h640M0 350h640M0 380h640M80 280v120m80-120v120m80-120v120m80-120v120m80-120v120m80-120v120m80-120v120" stroke="#75b7ff" stroke-opacity=".09"/>
    <g fill="none" stroke="#75b7ff" stroke-linejoin="round" stroke-width="5">
      <path d="m320 83 91 52v105l-91 52-91-52V135z" fill="#75b7ff" fill-opacity=".08"/>
      <path d="M320 188v104m0-104 91-53m-91 53-91-53"/>
    </g>
    <circle cx="320" cy="188" r="9" fill="#e8b77c"/>
    <text x="320" y="340" fill="#e8edf4" font-family="Arial,sans-serif" font-size="21" text-anchor="middle">${displayTitle}</text>
    <text x="320" y="371" fill="#9ba8b8" font-family="Arial,sans-serif" font-size="12" letter-spacing="2" text-anchor="middle">MODEL PREVIEW</text>
  </svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function getChatModelResults(results: ModelSearchResult[]): ModelSearchResult[] {
  return results
    .map((result, index) => ({ result, index }))
    .sort((first, second) => {
      const firstHasThumbnail = Boolean(first.result.image || first.result.imageFallback)
      const secondHasThumbnail = Boolean(second.result.image || second.result.imageFallback)
      return Number(secondHasThumbnail) - Number(firstHasThumbnail) || first.index - second.index
    })
    .slice(0, 3)
    .map(({ result }) => result)
}

function BuildVolumeGrid() {
  const halfSize = BUILD_VOLUME_SCENE_SIZE / 2
  const gridGeometry = useMemo(() => {
    const positions: number[] = []
    const divisions = BUILD_VOLUME_GRID_DIVISIONS
    const step = BUILD_VOLUME_SCENE_SIZE / divisions

    for (let first = 0; first <= divisions; first += 1) {
      for (let second = 0; second <= divisions; second += 1) {
        const firstCoordinate = -halfSize + first * step
        const secondCoordinate = -halfSize + second * step

        positions.push(-halfSize, firstCoordinate, secondCoordinate, halfSize, firstCoordinate, secondCoordinate)
        positions.push(firstCoordinate, -halfSize, secondCoordinate, firstCoordinate, halfSize, secondCoordinate)
        positions.push(firstCoordinate, secondCoordinate, -halfSize, firstCoordinate, secondCoordinate, halfSize)
      }
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    return geometry
  }, [halfSize])

  const boundaryGeometry = useMemo(() => {
    const corners = [
      [-halfSize, -halfSize, -halfSize],
      [halfSize, -halfSize, -halfSize],
      [-halfSize, halfSize, -halfSize],
      [halfSize, halfSize, -halfSize],
      [-halfSize, -halfSize, halfSize],
      [halfSize, -halfSize, halfSize],
      [-halfSize, halfSize, halfSize],
      [halfSize, halfSize, halfSize],
    ]
    const edges: [number, number][] = [
      [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
      [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
    ]
    const positions = edges.flatMap(([start, end]) => [...corners[start], ...corners[end]])
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    return geometry
  }, [halfSize])

  useEffect(() => () => {
    gridGeometry.dispose()
    boundaryGeometry.dispose()
  }, [boundaryGeometry, gridGeometry])

  return (
    <>
      <lineSegments geometry={gridGeometry}>
        <lineBasicMaterial color="#75b7ff" transparent opacity={0.18} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={boundaryGeometry}>
        <lineBasicMaterial color="#75b7ff" transparent opacity={0.72} depthWrite={false} />
      </lineSegments>
    </>
  )
}

function UploadedModelPreview({
  file,
  onFitCheck,
}: {
  file: File
  onFitCheck: (fitState: 'fits' | 'exceeds' | 'unknown') => void
}) {
  const [model, setModel] = useState<Object3D | null>(null)
  const [status, setStatus] = useState('Loading 3D model…')

  useEffect(() => {
    let cancelled = false
    let loadedModel: Object3D | null = null

    const loadFile = async () => {
      setModel(null)
      setStatus('Loading 3D model…')

      try {
        const extension = file.name.split('.').pop()?.toLowerCase()
        const buffer = await file.arrayBuffer()
        let object: Object3D

        if (extension === 'stl') {
          const geometry = new STLLoader().parse(buffer)
          geometry.computeVertexNormals()
          object = new Mesh(geometry, new MeshStandardMaterial({ color: '#75b7ff', metalness: 0.18, roughness: 0.48 }))
        } else if (extension === 'obj') {
          object = new OBJLoader().parse(new TextDecoder().decode(buffer))
        } else if (extension === '3mf') {
          object = new ThreeMFLoader().parse(buffer)
        } else if (extension === 'glb' || extension === 'gltf') {
          object = await new Promise<Object3D>((resolve, reject) => {
            new GLTFLoader().parse(buffer, '', (result) => resolve(result.scene), reject)
          })
        } else if (extension === 'fbx') {
          object = new FBXLoader().parse(buffer, '')
        } else if (extension === 'dae') {
          const collada = new ColladaLoader().parse(new TextDecoder().decode(buffer), '')
          if (!collada) throw new Error('Could not parse this Collada file.')
          object = collada.scene
        } else if (extension === 'ply') {
          const geometry = new PLYLoader().parse(buffer)
          geometry.computeVertexNormals()
          object = new Mesh(geometry, new MeshStandardMaterial({ color: '#75b7ff', metalness: 0.18, roughness: 0.48 }))
        } else if (extension === 'amf') {
          object = new AMFLoader().parse(buffer)
        } else if (extension === '3ds') {
          object = new TDSLoader().parse(buffer, '')
        } else if (extension === 'wrl' || extension === 'vrml') {
          object = new VRMLLoader().parse(new TextDecoder().decode(buffer), '')
        } else if (extension === 'gcode' || extension === 'gco' || extension === 'gc') {
          object = new GCodeLoader().parse(new TextDecoder().decode(buffer))
        } else if (extension === 'vtk') {
          const geometry = new VTKLoader().parse(buffer, '')
          geometry.computeVertexNormals()
          object = new Mesh(geometry, new MeshStandardMaterial({ color: '#75b7ff', metalness: 0.18, roughness: 0.48 }))
        } else if (extension === 'pcd') {
          object = new PCDLoader().parse(buffer)
        } else if (extension === 'vox') {
          const result = new VOXLoader().parse(buffer)
          if (!result?.scene) throw new Error('Could not parse this MagicaVoxel file.')
          object = result.scene
        } else if (extension === 'usdz' || extension === 'usd' || extension === 'usda') {
          object = await new Promise<Object3D>((resolve, reject) => {
            new USDLoader().parse(buffer, '', resolve, reject)
          })
        } else {
          throw new Error('Unsupported 3D format. Supported formats: STL, OBJ, 3MF, GLB, GLTF, FBX, DAE, PLY, AMF, 3DS, WRL, VRML, G-code, VTK, PCD, VOX, USD, and USDZ.')
        }

        const bounds = new Box3().setFromObject(object)
        if (bounds.isEmpty()) throw new Error('This file contains no visible 3D geometry.')

        const center = bounds.getCenter(new Vector3())
        const size = bounds.getSize(new Vector3())
        onFitCheck([size.x, size.y, size.z].every((dimension) => dimension <= BUILD_VOLUME_MM) ? 'fits' : 'exceeds')
        object.position.sub(center)

        const centeredModel = new Group()
        centeredModel.add(object)
        centeredModel.scale.setScalar(BUILD_VOLUME_SCENE_SIZE / Math.max(size.x, size.y, size.z, 0.001))
        loadedModel = centeredModel
        if (!cancelled) setModel(centeredModel)
      } catch (error) {
        if (!cancelled) {
          onFitCheck('unknown')
          setStatus(error instanceof Error ? error.message : 'Unable to display this 3D file.')
        }
      }
    }

    void loadFile()

    return () => {
      cancelled = true
      loadedModel?.traverse((child) => {
        if ('geometry' in child && child.geometry instanceof BufferGeometry) {
          child.geometry.dispose()
        }
        if ('material' in child) {
          const materials = Array.isArray(child.material) ? child.material : [child.material]
          materials.forEach((material) => material.dispose())
        }
      })
    }
  }, [file, onFitCheck])

  return model ? (
    <primitive object={model} />
  ) : (
    <Html center>
      <div className="model-load-status">{status}</div>
    </Html>
  )
}
