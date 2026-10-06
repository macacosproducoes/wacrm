'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Heart,
  Sparkles,
  CheckCircle2,
  Copy,
  Check,
  Loader2,
  ShieldCheck,
  RefreshCw,
  Zap,
  ArrowRight,
  Terminal,
  ChevronDown,
  ChevronUp,
  MessageCircle,
  Plus,
} from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { VoicePoweredOrb } from '@/components/ui/voice-powered-orb'

/* ─── Random donor generator ─── */
const RANDOM_NAMES = [
  'Lucas Oliveira', 'Fernanda Costa', 'Gabriel Santos', 'Mariana Lima',
  'Pedro Henrique', 'Beatriz Ferreira', 'Rafael Almeida', 'Juliana Souza',
  'Thiago Mendes', 'Camila Rocha', 'André Barbosa', 'Patrícia Dias',
  'Diego Martins', 'Larissa Pereira', 'Bruno Cardoso', 'Amanda Ribeiro',
]
const RANDOM_EMAILS = [
  'lucas@email.com', 'fecosta@mail.com', 'gabriel.s@email.com', 'mari.lima@mail.com',
  'pedroh@email.com', 'bia.f@mail.com', 'rafa@email.com', 'ju.souza@mail.com',
  'thiago.m@email.com', 'camila.r@mail.com', 'andre.b@email.com', 'pat.d@mail.com',
]
function generateValidCPF(): string {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  let d1 = n.reduce((total, number, index) => total + number * (10 - index), 0) % 11
  d1 = d1 < 2 ? 0 : 11 - d1
  let d2 = [...n, d1].reduce((total, number, index) => total + number * (11 - index), 0) % 11
  d2 = d2 < 2 ? 0 : 11 - d2
  return [...n, d1, d2].join('')
}

function generateRandomDonor() {
  const name = RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)]
  const email = RANDOM_EMAILS[Math.floor(Math.random() * RANDOM_EMAILS.length)]
  const cpf = generateValidCPF()
  const phone = `55119${Math.floor(Math.random() * 90000000 + 10000000)}`
  return { name, email, cpf, phone }
}

/* ─── Preset config ─── */
const PRESETS = [
  { amount: 100, label: '100' },
  { amount: 300, label: '300' },
  { amount: 500, label: '500' },
  { amount: 1000, label: '1K' },
]

export default function EdgarKatsumiMimosPage() {
  const [amount, setAmount] = useState<number>(100)
  const [inputValue, setInputValue] = useState<string>('')
  const [isEditing, setIsEditing] = useState(false)
  const [orderBumpActive, setOrderBumpActive] = useState(false)

  // Payment states
  const [isGenerating, setIsGenerating] = useState(false)
  const [paymentData, setPaymentData] = useState<any>(null)
  const [copiedPix, setCopiedPix] = useState(false)
  const [transactionStatus, setTransactionStatus] = useState<'idle' | 'pending' | 'paid'>('idle')
  const [showCelebration, setShowCelebration] = useState(false)
  const [showApiDocs, setShowApiDocs] = useState(false)

  const pollingRef = useRef<NodeJS.Timeout | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Orb hue
  const orbHue = showCelebration ? 120 : isGenerating ? 30 : transactionStatus === 'pending' ? 60 : 0

  // Total = amount + order bump
  const totalAmount = orderBumpActive ? amount + 350 : amount

  const handleAmountClick = () => {
    setIsEditing(true)
    setInputValue(amount.toString())
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const handleAmountBlur = () => {
    setIsEditing(false)
    const parsed = parseFloat(inputValue.replace(',', '.'))
    if (!isNaN(parsed) && parsed >= 6 && parsed <= 3000) {
      setAmount(Math.round(parsed * 100) / 100)
    } else if (!isNaN(parsed) && parsed < 6) {
      toast.error('Mínimo R$ 6,00')
      setAmount(6)
    } else if (!isNaN(parsed) && parsed > 3000) {
      toast.error('Máximo R$ 3.000,00')
      setAmount(3000)
    }
  }

  const handleAmountKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAmountBlur()
      setIsEditing(false)
    }
  }

  const selectPreset = (val: number) => {
    setAmount(val)
    setInputValue(val.toString())
    setIsEditing(false)
  }

  // Generate payment
  const handleGenerate = async () => {
    const finalAmount = totalAmount
    if (finalAmount < 6 || finalAmount > 3000) {
      toast.error('Valor total fora do limite (R$ 6 – R$ 3.000)')
      return
    }

    setIsGenerating(true)
    setPaymentData(null)
    setTransactionStatus('idle')
    setShowCelebration(false)

    const donor = generateRandomDonor()

    try {
      const res = await fetch('/api/mimos/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: finalAmount,
          payment_method: 'pix',
          name: donor.name,
          email: donor.email,
          cpf: donor.cpf,
          phone: donor.phone,
          message: orderBumpActive ? 'Mimo + Acesso WhatsApp VIP' : '',
        }),
      })

      const data = await res.json()

      if (!res.ok || data.error) {
        const errorMsg = data.error || 'Erro ao gerar pagamento'
        const detailMsg = data.detail ? `: ${data.detail}` : ''
        toast.error(`${errorMsg}${detailMsg}`)
        setIsGenerating(false)
        return
      }

      setPaymentData(data)
      setTransactionStatus('pending')
      toast.success(`PIX de R$ ${finalAmount.toFixed(2).replace('.', ',')} gerado!`)
    } catch {
      toast.error('Falha na conexão com o servidor')
    } finally {
      setIsGenerating(false)
    }
  }

  // Poll status
  useEffect(() => {
    if (!paymentData?.external_id || transactionStatus !== 'pending') {
      if (pollingRef.current) clearInterval(pollingRef.current)
      return
    }

    const check = async () => {
      try {
        const res = await fetch(`/api/mimos/status?external_id=${paymentData.external_id}`)
        const data = await res.json()
        if (data.success && data.status === 'paid') {
          setTransactionStatus('paid')
          setShowCelebration(true)
          toast.success('🎉 Pagamento confirmado!')
        }
      } catch {}
    }

    check()
    pollingRef.current = setInterval(check, 4000)
    return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
  }, [paymentData?.external_id, transactionStatus])

  const handleCopyPix = useCallback(() => {
    const code = paymentData?.data?.pix?.code
    if (code) {
      navigator.clipboard.writeText(code)
      setCopiedPix(true)
      toast.success('Código PIX copiado!')
      setTimeout(() => setCopiedPix(false), 3000)
    }
  }, [paymentData])


  const handleReset = () => {
    setPaymentData(null)
    setTransactionStatus('idle')
    setShowCelebration(false)
    setCopiedPix(false)
    setOrderBumpActive(false)
    setAmount(100)
  }

  return (
    <div className="min-h-screen bg-[#050508] text-white font-sans relative overflow-hidden selection:bg-purple-500/40">
      <Toaster theme="dark" position="top-center" />

      {/* Ambient background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-purple-600/[0.04] rounded-full blur-[120px]" />
        <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-blue-600/[0.03] rounded-full blur-[100px]" />
        <div className="absolute bottom-0 left-0 w-[300px] h-[300px] bg-indigo-600/[0.03] rounded-full blur-[80px]" />
      </div>

      {/* Header */}
      <header className="relative z-30 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-purple-600 to-pink-500 flex items-center justify-center text-[10px] font-black tracking-tighter">
            EK
          </div>
          <div>
            <span className="text-sm font-semibold text-white/90 tracking-tight">Edgar Katsumi</span>
            <span className="ml-2 text-[10px] text-purple-400/80 font-medium uppercase tracking-widest">Mimos</span>
          </div>
        </div>

        <button
          onClick={() => setShowApiDocs(!showApiDocs)}
          className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white/70 transition-colors font-mono"
        >
          <Terminal className="w-3.5 h-3.5" />
          API
          {showApiDocs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </header>

      {/* API Docs drawer */}
      {showApiDocs && (
        <div className="relative z-30 mx-6 mb-4 p-4 bg-white/[0.03] border border-white/[0.06] rounded-2xl backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px] font-mono">
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
              <span className="text-purple-400 font-bold">POST</span>
              <span className="text-white/50 ml-1">/v1/transactions</span>
              <p className="text-white/30 mt-1 font-sans text-[10px]">Cria PIX, Cartão ou Boleto</p>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
              <span className="text-emerald-400 font-bold">GET</span>
              <span className="text-white/50 ml-1">/v1/transactions/external_id/:id</span>
              <p className="text-white/30 mt-1 font-sans text-[10px]">Consulta status da transação</p>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
              <span className="text-amber-400 font-bold">LIMITES</span>
              <span className="text-white/50 ml-1">R$ 6 – R$ 3.000</span>
              <p className="text-white/30 mt-1 font-sans text-[10px]">Base: api.realtechdev.com.br</p>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════ MAIN STAGE ═══════════ */}
      <main className="relative z-10 flex flex-col items-center justify-center min-h-[calc(100vh-80px)] px-4 pb-8">

        {/* ═══ ORB + PRESETS LAYOUT ═══ */}
        <div className="relative flex flex-col items-center">

          {/* Orb container */}
          <div className="relative w-[300px] h-[300px] sm:w-[360px] sm:h-[360px] md:w-[400px] md:h-[400px]">
            {/* The Orb */}
            <div className="absolute inset-0 rounded-full overflow-hidden">
              <VoicePoweredOrb
                hue={orbHue}
                enableVoiceControl={false}
                className="w-full h-full"
              />
            </div>

            {/* Value overlay center */}
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
              {!paymentData ? (
                <div className="pointer-events-auto text-center">
                  <p className="text-[10px] uppercase tracking-[0.3em] text-white/25 font-medium mb-1">
                    Valor do Mimo
                  </p>

                  {isEditing ? (
                    <div className="flex items-baseline justify-center gap-1">
                      <span className="text-xl font-light text-white/30">R$</span>
                      <input
                        ref={inputRef}
                        type="number"
                        step="1"
                        min="6"
                        max="3000"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onBlur={handleAmountBlur}
                        onKeyDown={handleAmountKeyDown}
                        className="bg-transparent text-5xl sm:text-6xl font-extralight text-white text-center w-36 focus:outline-none appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={handleAmountClick}
                      className="group cursor-pointer transition-all"
                    >
                      <div className="flex items-baseline justify-center gap-1">
                        <span className="text-xl font-light text-white/30">R$</span>
                        <span className="text-5xl sm:text-6xl font-extralight text-white group-hover:text-white/80 transition-colors">
                          {amount % 1 === 0 ? amount : amount.toFixed(2).replace('.', ',')}
                        </span>
                      </div>
                      <p className="text-[9px] text-white/15 mt-1 group-hover:text-white/30 transition-colors tracking-wider">
                        toque para editar
                      </p>
                    </button>
                  )}
                </div>
              ) : transactionStatus === 'paid' ? (
                <div className="text-center pointer-events-auto">
                  <Sparkles className="w-10 h-10 text-emerald-400 mx-auto mb-2 animate-bounce" />
                  <p className="text-2xl font-light text-emerald-300">Confirmado</p>
                  <p className="text-xs text-white/30 mt-1">R$ {totalAmount.toFixed(2).replace('.', ',')}</p>
                </div>
              ) : (
                <div className="text-center">
                  <Loader2 className="w-6 h-6 text-purple-400 mx-auto mb-2 animate-spin" />
                  <p className="text-sm font-light text-white/50">Aguardando</p>
                  <p className="text-xs text-white/20">pagamento</p>
                </div>
              )}
            </div>
          </div>

          {/* ═══ LARGE PRESET CIRCLES — orbiting around the orb ═══ */}
          {!paymentData && (
            <>
              {/* R$ 100 — top-left */}
              <button
                onClick={() => selectPreset(100)}
                className="absolute z-20 group transition-all duration-300 hover:scale-110 active:scale-95"
                style={{ top: '-10px', left: '-30px' }}
              >
                <div className={`w-[72px] h-[72px] sm:w-[80px] sm:h-[80px] rounded-full flex flex-col items-center justify-center transition-all duration-300 shadow-xl ${
                  amount === 100
                    ? 'bg-purple-500/25 border-2 border-purple-400/60 shadow-purple-500/20'
                    : 'bg-white/[0.04] border border-white/[0.1] hover:bg-white/[0.08] hover:border-white/[0.2] shadow-black/20'
                }`}>
                  <span className="text-[10px] text-white/30 font-medium">R$</span>
                  <span className={`text-lg sm:text-xl font-semibold ${amount === 100 ? 'text-purple-300' : 'text-white/70 group-hover:text-white'}`}>100</span>
                </div>
              </button>

              {/* R$ 300 — top-right */}
              <button
                onClick={() => selectPreset(300)}
                className="absolute z-20 group transition-all duration-300 hover:scale-110 active:scale-95"
                style={{ top: '-10px', right: '-30px' }}
              >
                <div className={`w-[72px] h-[72px] sm:w-[80px] sm:h-[80px] rounded-full flex flex-col items-center justify-center transition-all duration-300 shadow-xl ${
                  amount === 300
                    ? 'bg-blue-500/25 border-2 border-blue-400/60 shadow-blue-500/20'
                    : 'bg-white/[0.04] border border-white/[0.1] hover:bg-white/[0.08] hover:border-white/[0.2] shadow-black/20'
                }`}>
                  <span className="text-[10px] text-white/30 font-medium">R$</span>
                  <span className={`text-lg sm:text-xl font-semibold ${amount === 300 ? 'text-blue-300' : 'text-white/70 group-hover:text-white'}`}>300</span>
                </div>
              </button>

              {/* R$ 500 — bottom-left */}
              <button
                onClick={() => selectPreset(500)}
                className="absolute z-20 group transition-all duration-300 hover:scale-110 active:scale-95"
                style={{ bottom: '60px', left: '-45px' }}
              >
                <div className={`w-[72px] h-[72px] sm:w-[80px] sm:h-[80px] rounded-full flex flex-col items-center justify-center transition-all duration-300 shadow-xl ${
                  amount === 500
                    ? 'bg-emerald-500/25 border-2 border-emerald-400/60 shadow-emerald-500/20'
                    : 'bg-white/[0.04] border border-white/[0.1] hover:bg-white/[0.08] hover:border-white/[0.2] shadow-black/20'
                }`}>
                  <span className="text-[10px] text-white/30 font-medium">R$</span>
                  <span className={`text-lg sm:text-xl font-semibold ${amount === 500 ? 'text-emerald-300' : 'text-white/70 group-hover:text-white'}`}>500</span>
                </div>
              </button>

              {/* R$ 1000 — bottom-right */}
              <button
                onClick={() => selectPreset(1000)}
                className="absolute z-20 group transition-all duration-300 hover:scale-110 active:scale-95"
                style={{ bottom: '60px', right: '-45px' }}
              >
                <div className={`w-[72px] h-[72px] sm:w-[80px] sm:h-[80px] rounded-full flex flex-col items-center justify-center transition-all duration-300 shadow-xl ${
                  amount === 1000
                    ? 'bg-amber-500/25 border-2 border-amber-400/60 shadow-amber-500/20'
                    : 'bg-white/[0.04] border border-white/[0.1] hover:bg-white/[0.08] hover:border-white/[0.2] shadow-black/20'
                }`}>
                  <span className="text-[10px] text-white/30 font-medium">R$</span>
                  <span className={`text-lg sm:text-xl font-semibold ${amount === 1000 ? 'text-amber-300' : 'text-white/70 group-hover:text-white'}`}>1K</span>
                </div>
              </button>

              {/* Security badge — small, at very bottom of orb */}
              <div className="absolute z-20" style={{ bottom: '-5px', left: '50%', transform: 'translateX(-50%)' }}>
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/[0.03] border border-white/[0.06] backdrop-blur-xl">
                  <ShieldCheck className="w-3 h-3 text-emerald-500/50" />
                  <span className="text-[9px] text-white/25 font-medium">BuckPay Seguro</span>
                  <span className="text-[9px] text-white/15">·</span>
                  <Zap className="w-3 h-3 text-amber-400/50" />
                  <span className="text-[9px] text-white/25 font-medium">PIX</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ═══ ORDER BUMP — WhatsApp Access R$ 350 ═══ */}
        {!paymentData && (
          <div className="mt-8 w-full max-w-md relative z-20">
            <button
              onClick={() => setOrderBumpActive(!orderBumpActive)}
              className={`w-full p-4 rounded-2xl border transition-all duration-300 text-left group ${
                orderBumpActive
                  ? 'bg-emerald-500/[0.08] border-emerald-500/30 shadow-lg shadow-emerald-900/20'
                  : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04] hover:border-white/[0.1]'
              }`}
            >
              <div className="flex items-center gap-4">
                {/* Checkbox circle */}
                <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                  orderBumpActive
                    ? 'border-emerald-400 bg-emerald-500/20'
                    : 'border-white/20 group-hover:border-white/40'
                }`}>
                  {orderBumpActive && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <MessageCircle className={`w-4 h-4 shrink-0 ${orderBumpActive ? 'text-emerald-400' : 'text-white/30'}`} />
                    <span className={`text-sm font-semibold ${orderBumpActive ? 'text-emerald-300' : 'text-white/70'}`}>
                      Acesso ao WhatsApp VIP
                    </span>
                    <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400/90 border border-amber-500/20">
                      BUMP
                    </span>
                  </div>
                  <p className={`text-[11px] leading-relaxed ${orderBumpActive ? 'text-white/40' : 'text-white/25'}`}>
                    Grupo exclusivo com acesso direto, suporte prioritário e conteúdo VIP do Edgar Katsumi
                  </p>
                </div>

                {/* Price */}
                <div className="text-right shrink-0">
                  <div className={`flex items-center gap-1 ${orderBumpActive ? 'text-emerald-300' : 'text-white/50'}`}>
                    <Plus className="w-3 h-3" />
                    <span className="text-lg font-semibold">350</span>
                  </div>
                  <span className="text-[10px] text-white/20">reais</span>
                </div>
              </div>
            </button>
          </div>
        )}

        {/* ═══ TOTAL + GENERATE BUTTON ═══ */}
        {!paymentData && (
          <div className="mt-6 flex flex-col items-center gap-3 relative z-20">
            {/* Show total if order bump is active */}
            {orderBumpActive && (
              <div className="flex items-center gap-3 text-xs text-white/30 animate-in fade-in duration-200">
                <span>Mimo R$ {amount}</span>
                <span className="text-emerald-400/60">+ WhatsApp R$ 350</span>
                <span className="text-white/10">=</span>
                <span className="text-white/60 font-semibold">R$ {totalAmount}</span>
              </div>
            )}

            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="group relative px-10 py-4 rounded-2xl bg-gradient-to-r from-purple-600/80 to-pink-600/80 hover:from-purple-500 hover:to-pink-500 text-white font-medium text-sm shadow-2xl shadow-purple-900/30 hover:shadow-purple-800/40 transition-all duration-300 flex items-center gap-3 disabled:opacity-40 active:scale-[0.97]"
            >
              {isGenerating ? (
                <span key="btn-loading-state" className="flex items-center gap-3">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>Gerando via BuckPay...</span>
                </span>
              ) : (
                <span key="btn-idle-state" className="flex items-center gap-3">
                  <Heart className="w-4 h-4 text-pink-200 fill-pink-200 group-hover:scale-110 transition-transform shrink-0" />
                  <span>Gerar PIX · R$ {totalAmount.toFixed(0)}</span>
                  <ArrowRight className="w-4 h-4 text-white/50 group-hover:translate-x-0.5 transition-transform shrink-0" />
                </span>
              )}
              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2/3 h-px bg-gradient-to-r from-transparent via-purple-400/40 to-transparent" />
            </button>
          </div>
        )}

        {/* ═══ PAYMENT RESULT ═══ */}
        {paymentData && paymentData.data?.pix && transactionStatus !== 'paid' && (
          <div className="mt-6 max-w-sm w-full relative z-20 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="p-6 rounded-3xl bg-white/[0.03] border border-white/[0.07] backdrop-blur-2xl shadow-2xl shadow-black/30 space-y-5">
              {/* QR Code */}
              <div className="flex justify-center">
                <div className="p-3 bg-white rounded-2xl shadow-inner">
                  <img
                    src={`data:image/png;base64,${paymentData.data.pix.qrcode_base64}`}
                    alt="QR Code PIX"
                    className="w-40 h-40 object-contain"
                  />
                </div>
              </div>

              {/* Copia e Cola */}
              <div className="space-y-2">
                <div className="p-2.5 bg-white/[0.03] rounded-xl border border-white/[0.05] font-mono text-[10px] text-white/40 break-all max-h-16 overflow-y-auto">
                  {paymentData.data.pix.code}
                </div>

                <button
                  onClick={handleCopyPix}
                  className="w-full py-2.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-medium text-white/60 hover:text-white/80 flex items-center justify-center gap-2 transition-all"
                >
                  {copiedPix ? (
                    <span key="copied" className="flex items-center gap-2 text-emerald-400">
                      <Check className="w-3.5 h-3.5" /> Copiado!
                    </span>
                  ) : (
                    <span key="copy" className="flex items-center gap-2">
                      <Copy className="w-3.5 h-3.5" /> Copiar código PIX
                    </span>
                  )}
                </button>
              </div>

              {/* Status */}
              <div className="flex items-center justify-between text-[10px] text-white/25 px-1">
                <div className="flex items-center gap-1.5">
                  <RefreshCw className="w-3 h-3 animate-spin text-purple-400/50" />
                  <span>Verificando a cada 4s</span>
                </div>
                <span className="font-mono">R$ {totalAmount.toFixed(2)}</span>
              </div>


            </div>
          </div>
        )}

        {/* ═══ CELEBRATION ═══ */}
        {showCelebration && (
          <div className="mt-6 max-w-sm w-full relative z-20 animate-in fade-in zoom-in-95 duration-500">
            <div className="p-8 rounded-3xl bg-emerald-500/[0.04] border border-emerald-500/[0.12] backdrop-blur-2xl shadow-2xl text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-7 h-7 text-emerald-400" />
              </div>
              <div>
                <h3 className="text-lg font-light text-emerald-300">Mimo Recebido!</h3>
                <p className="text-xs text-white/30 mt-1">
                  R$ {totalAmount.toFixed(2).replace('.', ',')} confirmado via BuckPay
                </p>
                {orderBumpActive && (
                  <p className="text-[11px] text-emerald-400/60 mt-2 flex items-center justify-center gap-1">
                    <MessageCircle className="w-3 h-3" /> WhatsApp VIP desbloqueado!
                  </p>
                )}
              </div>

              <button
                onClick={handleReset}
                className="px-6 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-xs text-white/50 hover:text-white/80 transition-all"
              >
                Enviar outro Mimo
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="relative z-10 py-4 text-center">
        <p className="text-[10px] text-white/15 tracking-wider">
          Edgar Katsumi · Mimos via BuckPay API
        </p>
      </footer>
    </div>
  )
}
