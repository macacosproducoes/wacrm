'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Zap,
  Sparkles,
  CheckCircle2,
  Copy,
  Check,
  Loader2,
  ShieldCheck,
  RefreshCw,
  ArrowRight,
  Terminal,
  ChevronDown,
  ChevronUp,
  MessageCircle,
  Plus,
  Flame,
  TrendingUp,
  Users,
  Eye,
  Heart,
  Globe,
  Share2,
  HelpCircle,
  Clock,
  Lock,
} from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { VoicePoweredOrb } from '@/components/ui/voice-powered-orb'

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
    </svg>
  )
}

/* ──── SMM SERVICES CATALOG ──── */
const SMM_SERVICES = [
  {
    id: 'recarga',
    name: 'Recarga de Saldo Painel',
    tag: 'Créditos',
    icon: Zap,
    desc: 'Saldo imediato creditado na sua conta SMM para usar em qualquer serviço.',
  },
  {
    id: 'seguidores',
    name: 'Seguidores Reais Brasil',
    tag: 'Instagram VIP',
    icon: Users,
    desc: 'Perfis brasileiros reais com alta retenção e entrega gradual orgânica.',
  },
  {
    id: 'curtidas',
    name: 'Curtidas & Engajamento',
    tag: 'Reels & Posts',
    icon: Heart,
    desc: 'Curtidas instantâneas de contas ativas para acelerar o algoritmo.',
  },
  {
    id: 'views',
    name: 'Visualizações Turbo',
    tag: 'Reels / TikTok',
    icon: Eye,
    desc: 'Milhares de visualizações de alta velocidade para seus vídeos e lives.',
  },
]

/* ──── QUICK RECHARGE PRESETS ──── */
const PRESETS = [
  { amount: 25, label: '25', credits: '1.000 pts' },
  { amount: 50, label: '50', credits: '2.500 pts' },
  { amount: 100, label: '100', credits: '5.500 pts' },
  { amount: 250, label: '250', credits: '15.000 pts' },
  { amount: 500, label: '500', credits: '35.000 pts' },
]

export default function SmmCheckoutPage() {
  const [selectedService, setSelectedService] = useState(SMM_SERVICES[0])
  const [amount, setAmount] = useState<number>(50)
  const [inputValue, setInputValue] = useState<string>('')
  const [isEditing, setIsEditing] = useState(false)
  const [orderBumpActive, setOrderBumpActive] = useState(false)

  // Customer form inputs
  const [instagram, setInstagram] = useState('')
  const [phone, setPhone] = useState('')
  const [customerName, setCustomerName] = useState('')

  // Payment states
  const [isGenerating, setIsGenerating] = useState(false)
  const [paymentData, setPaymentData] = useState<any>(null)
  const [copiedPix, setCopiedPix] = useState(false)
  const [transactionStatus, setTransactionStatus] = useState<'idle' | 'pending' | 'paid'>('idle')
  const [showCelebration, setShowCelebration] = useState(false)
  const [showApiDocs, setShowApiDocs] = useState(false)
  const [timeLeft, setTimeLeft] = useState(900) // 15 minutes timer

  const pollingRef = useRef<NodeJS.Timeout | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Orb electric hue: 195 (cyber cyan) normally, 120 (emerald) on paid, 30 (amber) on generating, 270 (purple) on pending
  const orbHue = showCelebration ? 120 : isGenerating ? 30 : transactionStatus === 'pending' ? 270 : 195

  // Total = amount + order bump (R$ 19 for Turbo express queue)
  const turboPrice = 19
  const totalAmount = orderBumpActive ? amount + turboPrice : amount

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
      toast.error('Valor mínimo R$ 6,00')
      setAmount(6)
    } else if (!isNaN(parsed) && parsed > 3000) {
      toast.error('Valor máximo R$ 3.000,00')
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

  // 15-minute countdown timer when PIX is active
  useEffect(() => {
    if (transactionStatus !== 'pending') return
    const timer = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)
    return () => clearInterval(timer)
  }, [transactionStatus])

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // Generate PIX Payment via BuckPay SMM route
  const handleGenerate = async () => {
    const finalAmount = totalAmount
    if (finalAmount < 6 || finalAmount > 3000) {
      toast.error('Valor total fora do limite (R$ 6,00 a R$ 3.000,00)')
      return
    }

    setIsGenerating(true)
    setPaymentData(null)
    setTransactionStatus('idle')
    setShowCelebration(false)
    setTimeLeft(900)

    try {
      const res = await fetch('/api/smm/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: finalAmount,
          payment_method: 'pix',
          name: customerName.trim() || undefined,
          phone: phone.trim() || undefined,
          instagram: instagram.trim().replace('@', '') || undefined,
          service_name: selectedService.name,
          order_bump: orderBumpActive,
        }),
      })

      const data = await res.json()

      if (!res.ok || data.error) {
        const errorMsg = data.error || 'Erro ao gerar pagamento SMM'
        const detailMsg = data.detail ? `: ${data.detail}` : ''
        toast.error(`${errorMsg}${detailMsg}`)
        setIsGenerating(false)
        return
      }

      setPaymentData(data)
      setTransactionStatus('pending')
      toast.success(`PIX de R$ ${finalAmount.toFixed(2).replace('.', ',')} gerado com sucesso!`)
    } catch {
      toast.error('Falha de conexão com o servidor de pagamento')
    } finally {
      setIsGenerating(false)
    }
  }

  // Poll transaction status in real-time
  useEffect(() => {
    if (!paymentData?.external_id || transactionStatus !== 'pending') {
      if (pollingRef.current) clearInterval(pollingRef.current)
      return
    }

    const check = async () => {
      try {
        const res = await fetch(`/api/smm/status?external_id=${paymentData.external_id}`)
        const data = await res.json()
        if (data.success && data.status === 'paid') {
          setTransactionStatus('paid')
          setShowCelebration(true)
          toast.success('🎉 Pagamento PIX aprovado! Créditos SMM liberados!')
        }
      } catch {}
    }

    check()
    pollingRef.current = setInterval(check, 3500)
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [paymentData?.external_id, transactionStatus])

  const handleCopyPix = useCallback(() => {
    const code = paymentData?.data?.pix?.code
    if (code) {
      navigator.clipboard.writeText(code)
      setCopiedPix(true)
      toast.success('Código PIX Copia e Cola copiado!')
      setTimeout(() => setCopiedPix(false), 3000)
    }
  }, [paymentData])

  const handleReset = () => {
    setPaymentData(null)
    setTransactionStatus('idle')
    setShowCelebration(false)
    setCopiedPix(false)
    setOrderBumpActive(false)
    setAmount(50)
  }

  return (
    <div className="min-h-screen bg-[#06070B] text-white font-sans relative overflow-x-hidden selection:bg-cyan-500/30">
      <Toaster theme="dark" position="top-center" />

      {/* Cyber Neon Ambient Background Lights */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[550px] bg-gradient-to-b from-cyan-600/[0.07] via-purple-600/[0.05] to-transparent rounded-full blur-[140px]" />
        <div className="absolute top-1/3 left-0 w-[450px] h-[450px] bg-cyan-500/[0.04] rounded-full blur-[120px]" />
        <div className="absolute bottom-10 right-0 w-[500px] h-[500px] bg-purple-600/[0.05] rounded-full blur-[130px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff05_1px,transparent_1px),linear-gradient(to_bottom,#ffffff05_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] opacity-40" />
      </div>

      {/* Top Navigation Bar */}
      <header className="relative z-30 flex items-center justify-between px-5 sm:px-8 py-4 border-b border-white/[0.06] backdrop-blur-md bg-black/30">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-cyan-500 via-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20">
            <Zap className="h-5 w-5 fill-white stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-100 to-cyan-300 bg-clip-text text-transparent">
                SMM PANEL
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                API 24/7 ONLINE
              </span>
            </div>
            <p className="text-[11px] text-white/40 font-medium">
              Engajamento Real & Créditos de Alta Velocidade
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowApiDocs(!showApiDocs)}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 bg-white/[0.03] text-xs font-mono text-white/60 hover:text-white hover:bg-white/[0.07] transition-all"
          >
            <Terminal className="h-3.5 w-3.5 text-cyan-400" />
            <span>API Docs</span>
            {showApiDocs ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
      </header>

      {/* API Docs Drawer */}
      {showApiDocs && (
        <div className="relative z-30 mx-4 sm:mx-8 mt-3 p-4 bg-black/60 border border-cyan-500/20 rounded-2xl backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-200 shadow-2xl">
          <div className="flex items-center justify-between mb-3 border-b border-white/10 pb-2">
            <span className="text-xs font-mono font-semibold text-cyan-400 flex items-center gap-1.5">
              <Terminal className="h-4 w-4" /> Endpoints Integrados SMM
            </span>
            <span className="text-[10px] text-white/40 font-mono">Gateway: BuckPay RealTech</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06]">
              <span className="text-cyan-400 font-bold">POST</span>
              <span className="text-white/60 ml-1.5">/api/smm/pay</span>
              <p className="text-white/40 mt-1 font-sans text-[11px]">Gera transação PIX com QR Code base64 e código copia e cola.</p>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06]">
              <span className="text-emerald-400 font-bold">GET</span>
              <span className="text-white/60 ml-1.5">/api/smm/status</span>
              <p className="text-white/40 mt-1 font-sans text-[11px]">Verifica aprovação do pagamento em tempo real por external_id.</p>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06]">
              <span className="text-amber-400 font-bold">FAIXA</span>
              <span className="text-white/60 ml-1.5">R$ 6,00 a R$ 3.000,00</span>
              <p className="text-white/40 mt-1 font-sans text-[11px]">Processamento instantâneo com webhook e postback automático.</p>
            </div>
          </div>
        </div>
      )}

      {/* Main Container */}
      <main className="relative z-10 max-w-4xl mx-auto px-4 py-8 sm:py-12 flex flex-col items-center">

        {/* Hero Title */}
        <div className="text-center max-w-xl mx-auto mb-8 space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 text-xs font-semibold uppercase tracking-wider mb-2">
            <Flame className="h-3.5 w-3.5 text-cyan-400 fill-cyan-400" />
            Checkout SMM Instantâneo
          </div>
          <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight text-white">
            Recarga de Saldo & Pedidos <span className="bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">SMM</span>
          </h1>
          <p className="text-xs sm:text-sm text-white/50 leading-relaxed">
            Selecione o serviço ou recarregue seu saldo. Liberação imediata via PIX automático com segurança bancária.
          </p>
        </div>

        {/* Service Type Selector Cards */}
        {!paymentData && (
          <div className="w-full grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 mb-8">
            {SMM_SERVICES.map((srv) => {
              const Icon = srv.icon
              const isSelected = selectedService.id === srv.id
              return (
                <button
                  key={srv.id}
                  type="button"
                  onClick={() => setSelectedService(srv)}
                  className={`relative flex flex-col items-start p-3 sm:p-4 rounded-2xl border text-left transition-all duration-300 ${
                    isSelected
                      ? 'border-cyan-400 bg-cyan-500/15 ring-2 ring-cyan-500/30 shadow-lg shadow-cyan-900/30'
                      : 'border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center justify-between w-full mb-2">
                    <div className={`p-2 rounded-xl ${isSelected ? 'bg-cyan-500 text-black' : 'bg-white/5 text-cyan-400'}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-white/5 text-white/50 border border-white/5">
                      {srv.tag}
                    </span>
                  </div>
                  <h4 className="text-xs sm:text-sm font-bold text-white mb-0.5 leading-snug">
                    {srv.name}
                  </h4>
                  <p className="text-[10px] text-white/40 line-clamp-2 leading-relaxed">
                    {srv.desc}
                  </p>
                </button>
              )
            })}
          </div>
        )}

        {/* ──── THE ORB & PRESET SELECTOR ──── */}
        <div className="relative flex flex-col items-center w-full my-2">
          {/* Central Orb */}
          <div className="relative w-[280px] h-[280px] sm:w-[350px] sm:h-[350px] md:w-[380px] md:h-[380px]">
            <div className="absolute inset-0 rounded-full overflow-hidden">
              <VoicePoweredOrb
                hue={orbHue}
                enableVoiceControl={false}
                className="w-full h-full"
              />
            </div>

            {/* Value overlay inside Orb */}
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
              {!paymentData ? (
                <div className="pointer-events-auto text-center px-4">
                  <p className="text-[10px] uppercase tracking-[0.25em] text-cyan-300/60 font-semibold mb-1">
                    Valor da Recarga SMM
                  </p>

                  {isEditing ? (
                    <div className="flex items-baseline justify-center gap-1">
                      <span className="text-xl font-light text-cyan-400/50">R$</span>
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
                        className="bg-transparent text-5xl sm:text-6xl font-light text-white text-center w-36 focus:outline-none appearance-none"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={handleAmountClick}
                      className="group cursor-pointer transition-all hover:scale-105 active:scale-95"
                    >
                      <div className="flex items-baseline justify-center gap-1">
                        <span className="text-xl font-light text-cyan-400/50">R$</span>
                        <span className="text-5xl sm:text-6xl font-extralight text-white group-hover:text-cyan-200 transition-colors drop-shadow-lg">
                          {amount % 1 === 0 ? amount : amount.toFixed(2).replace('.', ',')}
                        </span>
                      </div>
                      <p className="text-[10px] text-white/30 mt-1 group-hover:text-cyan-400 transition-colors tracking-wider font-mono">
                        toque para digitar outro valor
                      </p>
                    </button>
                  )}

                  <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-cyan-950/60 border border-cyan-500/30 text-[10px] text-cyan-300 font-medium">
                    <Sparkles className="h-3 w-3 text-cyan-400" />
                    <span>{selectedService.name}</span>
                  </div>
                </div>
              ) : transactionStatus === 'paid' ? (
                <div className="text-center pointer-events-auto animate-in zoom-in-90 duration-300">
                  <div className="h-14 w-14 rounded-full bg-emerald-500/20 border-2 border-emerald-400 flex items-center justify-center mx-auto mb-2 shadow-lg shadow-emerald-500/30">
                    <CheckCircle2 className="h-8 w-8 text-emerald-400 animate-pulse" />
                  </div>
                  <p className="text-2xl font-bold text-emerald-300">Aprovado!</p>
                  <p className="text-xs text-white/60 mt-1 font-mono">R$ {totalAmount.toFixed(2).replace('.', ',')}</p>
                </div>
              ) : (
                <div className="text-center">
                  <Loader2 className="w-8 h-8 text-cyan-400 mx-auto mb-2 animate-spin" />
                  <p className="text-sm font-semibold text-white/70">Aguardando PIX</p>
                  <p className="text-[11px] text-white/30 font-mono mt-0.5">{formatTimer(timeLeft)}</p>
                </div>
              )}
            </div>
          </div>

          {/* Quick preset chips below orb */}
          {!paymentData && (
            <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 mt-4 z-20">
              {PRESETS.map((p) => {
                const isActive = amount === p.amount
                return (
                  <button
                    key={p.amount}
                    type="button"
                    onClick={() => selectPreset(p.amount)}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all duration-200 flex flex-col items-center ${
                      isActive
                        ? 'bg-gradient-to-r from-cyan-500 to-indigo-600 text-white shadow-lg shadow-cyan-500/30 scale-105'
                        : 'bg-white/[0.04] border border-white/[0.08] text-white/70 hover:bg-white/[0.08] hover:text-white'
                    }`}
                  >
                    <span>R$ {p.label}</span>
                    <span className="text-[9px] font-normal opacity-70">{p.credits}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Customer Form (Instagram + WhatsApp) */}
        {!paymentData && (
          <div className="w-full max-w-md mt-6 p-5 rounded-2xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-xl space-y-3 z-20">
            <h3 className="text-xs font-semibold text-white/80 uppercase tracking-wider flex items-center gap-1.5">
              <InstagramIcon className="h-3.5 w-3.5 text-cyan-400" />
              Destinatário do Pedido SMM
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-white/60 mb-1">
                  Instagram (@usuario ou link)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-xs text-white/30 font-mono">@</span>
                  <input
                    type="text"
                    value={instagram}
                    onChange={(e) => setInstagram(e.target.value.replace('@', ''))}
                    placeholder="seu_perfil"
                    className="w-full h-9 pl-7 pr-3 rounded-lg border border-white/10 bg-black/40 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-white/60 mb-1">
                  WhatsApp (DDD + Número)
                </label>
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Ex: 11999999999"
                  className="w-full h-9 px-3 rounded-lg border border-white/10 bg-black/40 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-white/60 mb-1">
                Seu Nome (Opcional)
              </label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Ex: Lucas Silva"
                className="w-full h-9 px-3 rounded-lg border border-white/10 bg-black/40 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
              />
            </div>
          </div>
        )}

        {/* Order Bump - Fila Turbo Express */}
        {!paymentData && (
          <div className="w-full max-w-md mt-4 z-20">
            <button
              type="button"
              onClick={() => setOrderBumpActive(!orderBumpActive)}
              className={`w-full p-4 rounded-2xl border transition-all duration-300 text-left ${
                orderBumpActive
                  ? 'bg-cyan-500/[0.09] border-cyan-400/50 shadow-lg shadow-cyan-900/20'
                  : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04] hover:border-white/10'
              }`}
            >
              <div className="flex items-center gap-3.5">
                <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                  orderBumpActive ? 'border-cyan-400 bg-cyan-500/20' : 'border-white/20'
                }`}>
                  {orderBumpActive && <Check className="w-3.5 h-3.5 text-cyan-400 stroke-[3]" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <Flame className={`w-4 h-4 shrink-0 ${orderBumpActive ? 'text-cyan-400' : 'text-white/40'}`} />
                    <span className={`text-xs sm:text-sm font-bold ${orderBumpActive ? 'text-cyan-300' : 'text-white/80'}`}>
                      Turbo Fila Express + Prioridade Máxima
                    </span>
                    <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                      TURBO
                    </span>
                  </div>
                  <p className="text-[11px] text-white/40 leading-relaxed">
                    Seus pedidos são alocados nos servidores VIP prioritários com velocidade 3x maior e sem fila.
                  </p>
                </div>

                <div className="text-right shrink-0">
                  <div className={`flex items-center gap-0.5 ${orderBumpActive ? 'text-cyan-300' : 'text-white/60'}`}>
                    <Plus className="w-3 h-3" />
                    <span className="text-base font-bold">19</span>
                  </div>
                  <span className="text-[10px] text-white/30">reais</span>
                </div>
              </div>
            </button>
          </div>
        )}

        {/* Generate PIX Button */}
        {!paymentData && (
          <div className="mt-6 flex flex-col items-center gap-3 w-full max-w-md z-20">
            {orderBumpActive && (
              <div className="flex items-center gap-3 text-xs text-white/40">
                <span>Recarga R$ {amount}</span>
                <span className="text-cyan-400">+ Fila Turbo R$ {turboPrice}</span>
                <span className="text-white/20">=</span>
                <span className="text-white font-bold">R$ {totalAmount}</span>
              </div>
            )}

            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="w-full py-4 px-6 rounded-2xl bg-gradient-to-r from-cyan-500 via-indigo-600 to-purple-600 hover:from-cyan-400 hover:via-indigo-500 hover:to-purple-500 text-white font-bold text-sm sm:text-base shadow-xl shadow-cyan-900/30 hover:shadow-cyan-800/50 transition-all duration-300 flex items-center justify-center gap-2.5 disabled:opacity-50 active:scale-[0.98]"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>Gerando PIX Instantâneo...</span>
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 fill-white shrink-0" />
                  <span>Gerar PIX • R$ {totalAmount.toFixed(2).replace('.', ',')}</span>
                  <ArrowRight className="w-4 h-4 shrink-0 opacity-70" />
                </>
              )}
            </button>

            {/* Security Guarantee Strip */}
            <div className="flex items-center justify-center gap-3 text-[11px] text-white/30 mt-1">
              <span className="flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                Pagamento Seguro
              </span>
              <span>•</span>
              <span className="flex items-center gap-1">
                <Lock className="h-3 w-3 text-cyan-400" />
                Criptografia 256-bit
              </span>
              <span>•</span>
              <span>Liberação Automática</span>
            </div>
          </div>
        )}

        {/* ──── PAYMENT RESULT (QR CODE + COPIA E COLA) ──── */}
        {paymentData && paymentData.data?.pix && transactionStatus !== 'paid' && (
          <div className="w-full max-w-sm mt-4 z-20 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="p-6 rounded-3xl bg-black/60 border border-cyan-500/30 backdrop-blur-2xl shadow-2xl shadow-cyan-950/40 space-y-5">
              <div className="text-center">
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-[10px] font-mono text-cyan-300 mb-2">
                  <Clock className="w-3 h-3 text-cyan-400" />
                  Expira em {formatTimer(timeLeft)}
                </span>
                <h3 className="text-lg font-bold text-white">Escaneie o QR Code PIX</h3>
                <p className="text-xs text-white/50 mt-0.5">
                  Abra o app do seu banco e pague via PIX
                </p>
              </div>

              {/* QR Code Container */}
              <div className="flex justify-center">
                <div className="p-3.5 bg-white rounded-2xl shadow-2xl">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:image/png;base64,${paymentData.data.pix.qrcode_base64}`}
                    alt="QR Code PIX SMM"
                    className="w-44 h-44 object-contain"
                  />
                </div>
              </div>

              {/* Amount and Service badge */}
              <div className="p-3 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-between text-xs font-mono">
                <div>
                  <span className="text-white/40 block text-[10px]">SERVIÇO</span>
                  <span className="text-white font-bold">{selectedService.name}</span>
                </div>
                <div className="text-right">
                  <span className="text-white/40 block text-[10px]">VALOR TOTAL</span>
                  <span className="text-cyan-300 font-extrabold text-sm">
                    R$ {totalAmount.toFixed(2).replace('.', ',')}
                  </span>
                </div>
              </div>

              {/* PIX Copy & Paste Button */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={handleCopyPix}
                  className={`w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all duration-200 ${
                    copiedPix
                      ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/30'
                      : 'bg-gradient-to-r from-cyan-500 to-indigo-600 text-white hover:opacity-95 shadow-lg shadow-cyan-900/30'
                  }`}
                >
                  {copiedPix ? (
                    <>
                      <Check className="w-4 h-4 stroke-[3]" />
                      <span>Código PIX Copiado!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      <span>Copiar Código PIX (Copia e Cola)</span>
                    </>
                  )}
                </button>
              </div>

              {/* Live Status Indicator */}
              <div className="flex items-center justify-center gap-2 pt-2 text-xs text-white/50">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                <span>Identificando pagamento automaticamente...</span>
              </div>

              <div className="text-center pt-1 border-t border-white/5">
                <button
                  onClick={handleReset}
                  className="text-xs text-white/40 hover:text-white transition-colors underline"
                >
                  Cancelar e alterar valor
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ──── PAID SUCCESS CELEBRATION ──── */}
        {transactionStatus === 'paid' && (
          <div className="w-full max-w-md mt-6 z-20 animate-in fade-in zoom-in-95 duration-500">
            <div className="p-6 rounded-3xl bg-black/70 border-2 border-emerald-500/40 backdrop-blur-2xl shadow-2xl shadow-emerald-950/50 space-y-5 text-center">
              <div className="inline-flex p-4 rounded-full bg-emerald-500/20 border-2 border-emerald-400 text-emerald-400 mb-1">
                <CheckCircle2 className="w-10 h-10 animate-bounce" />
              </div>

              <div>
                <h3 className="text-xl sm:text-2xl font-extrabold text-white">
                  Pagamento Confirmado!
                </h3>
                <p className="text-xs text-emerald-400 font-medium mt-1">
                  Seus créditos SMM foram liberados instantaneamente.
                </p>
              </div>

              <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/[0.08] text-left space-y-2 text-xs font-mono">
                <div className="flex justify-between border-b border-white/5 pb-1.5">
                  <span className="text-white/40">Status:</span>
                  <span className="text-emerald-400 font-bold">APROVADO (PIX)</span>
                </div>
                <div className="flex justify-between border-b border-white/5 pb-1.5">
                  <span className="text-white/40">Serviço:</span>
                  <span className="text-white">{selectedService.name}</span>
                </div>
                {instagram && (
                  <div className="flex justify-between border-b border-white/5 pb-1.5">
                    <span className="text-white/40">Conta:</span>
                    <span className="text-cyan-300">@{instagram}</span>
                  </div>
                )}
                <div className="flex justify-between pt-0.5">
                  <span className="text-white/40">Valor Pago:</span>
                  <span className="text-emerald-400 font-bold text-sm">
                    R$ {totalAmount.toFixed(2).replace('.', ',')}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleReset}
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-black font-extrabold text-sm shadow-xl shadow-emerald-900/30 transition-all duration-200"
              >
                Fazer Novo Pedido SMM
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="relative z-20 py-8 border-t border-white/[0.06] text-center text-xs text-white/30">
        <p>SMM PANEL • Infraestrutura de Alta Performance para Redes Sociais</p>
        <p className="mt-1 text-[11px] text-white/20">
          Pagamentos processados de forma segura via BuckPay Pagamentos SA.
        </p>
      </footer>
    </div>
  )
}
