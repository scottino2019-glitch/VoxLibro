/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  Upload, 
  BookOpen, 
  Volume2, 
  Globe,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ScanEye,
  Sparkles
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import { extractTextFromPdf, renderPageToImage, getNumPages } from './lib/pdf';
import { cn } from './lib/utils';

// We'll initialize Gemini lazily to avoid crashes if the API key is missing during boot
let aiInstance: GoogleGenAI | null = null;

const getGeminiAI = () => {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY || "";

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not defined. Please set it in your environment variables.");
    }

    aiInstance = new GoogleGenAI({
      apiKey,
    });
  }

  return aiInstance;
};

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [chunks, setChunks] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isReading, setIsReading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isOcrLoading, setIsOcrLoading] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);

  const synth = window.speechSynthesis;
  const isReadingRef = useRef(false);
  const playTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const speedRef = useRef(speed);
  const selectedVoiceRef = useRef(selectedVoice);
  const currentIndexRef = useRef(currentIndex);

  // Sync refs with state
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { selectedVoiceRef.current = selectedVoice; }, [selectedVoice]);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);

  // Initialize voices
  useEffect(() => {
    const loadVoices = () => {
      const availableVoices = synth.getVoices();
      // Remove duplicates by voiceURI to be safe
      const seen = new Set<string>();
      const uniqueVoices = availableVoices.filter(v => {
        if (!v.voiceURI || seen.has(v.voiceURI)) return false;
        seen.add(v.voiceURI);
        return true;
      });
      setVoices(uniqueVoices);
      const defaultVoice = uniqueVoices.find(v => v.lang.startsWith('it')) || uniqueVoices[0];
      setSelectedVoice(defaultVoice);
    };

    loadVoices();
    if (synth.onvoiceschanged !== undefined) {
      synth.onvoiceschanged = loadVoices;
    }

    return () => {
      synth.cancel();
      if (playTimeoutRef.current) clearTimeout(playTimeoutRef.current);
    };
  }, []);

  const stopReading = useCallback(() => {
    synth.cancel();
    isReadingRef.current = false;
    setIsReading(false);
    if (playTimeoutRef.current) {
      clearTimeout(playTimeoutRef.current);
      playTimeoutRef.current = null;
    }
  }, [synth]);

  const handlePlayPage = useCallback((index: number) => {
    if (!chunks[index]) return;

    // Aggressive cleanup
    if (playTimeoutRef.current) {
      clearTimeout(playTimeoutRef.current);
    }
    synth.cancel();
    isReadingRef.current = false;
    setIsReading(false);
    
    // Slightly longer delay for synthesis to settle
    playTimeoutRef.current = setTimeout(() => {
      if (!chunks[index] || index >= chunks.length) return;

      isReadingRef.current = true;
      setIsReading(true);

      const cleanText = chunks[index].replace(/\s+/g, ' ').trim();
      const utterance = new SpeechSynthesisUtterance(cleanText);
      
      // Use Refs for latest values to avoid closure issues
      const currentVoice = selectedVoiceRef.current;
      const currentSpeed = speedRef.current;

      if (currentVoice) {
        utterance.voice = currentVoice;
        utterance.lang = currentVoice.lang;
      } else {
        utterance.lang = 'it-IT';
      }
      
      // Critical: Ensure rate is correctly applied
      utterance.rate = currentSpeed;
      
      console.log(`Speaking page ${index + 1} at rate ${currentSpeed}`);

      utterance.onend = () => {
        if (isReadingRef.current) {
          const nextIndex = index + 1;
          if (nextIndex < chunks.length) {
            setCurrentIndex(nextIndex);
            handlePlayPage(nextIndex);
          } else {
            stopReading();
          }
        }
      };

      utterance.onerror = (event) => {
        if (event.error !== 'interrupted') {
          console.error('SpeechSynthesis Error:', event.error);
          stopReading();
        }
      };

      setCurrentIndex(index);
      synth.speak(utterance);

      const element = document.getElementById(`chunk-${index}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 150); 
  }, [chunks, synth, stopReading]);

  // Reactive restart on speed/voice change
  useEffect(() => {
    if (isReading) {
      const debounceTimer = setTimeout(() => {
        handlePlayPage(currentIndexRef.current);
      }, 400);
      return () => clearTimeout(debounceTimer);
    }
  }, [speed, selectedVoice, handlePlayPage]);

  const toggleReading = () => {
    if (isReading) {
      stopReading();
    } else {
      handlePlayPage(currentIndex);
    }
  };

  const resetReading = () => {
    stopReading();
    setCurrentIndex(0);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0];
    if (uploadedFile) {
      setIsLoading(true);
      setFile(uploadedFile);
      setChunks([]);
      setCurrentIndex(0);
      try {
        const textChunks = await extractTextFromPdf(uploadedFile);
        setChunks(textChunks);
      } catch (error) {
        console.error('Error parsing PDF:', error);
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleOcr = async () => {
    if (!file) return;
    setIsOcrLoading(true);
    try {
      const ai = getGeminiAI();
      const totalPages = await getNumPages(file);
      
      for (let i = 1; i <= totalPages; i++) {
        const base64Image = await renderPageToImage(file, i);
        
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            "Trascrivi accuratamente tutto il testo presente in questa pagina di libro per un audiolettore. Restituisci esclusivamente il testo estratto, mantieni i paragrafi originali, non aggiungere commenti o descrizioni delle immagini.",
            {
              inlineData: {
                data: base64Image,
                mimeType: "image/jpeg",
              },
            },
          ],
        });
        
        const extractedText = response.text?.trim();
        if (extractedText) {
          setChunks(prev => [...prev, extractedText]);
        }
      }
    } catch (error: any) {
      console.error('OCR failed:', error);
      const message = error?.message || '';
      if (message.includes("GEMINI_API_KEY")) {
        alert("Configurazione mancante: La chiave API di Gemini non è impostata su Vercel. Aggiungi GEMINI_API_KEY alle variabili d'ambiente del tuo progetto.");
      } else {
        alert('Errore nel riconoscimento del testo AI. Verifica la connessione o riprova più tardi.');
      }
    } finally {
      setIsOcrLoading(false);
    }
  };

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  return (
    <div className="w-full h-screen bg-[#FDFCFB] text-[#1A1A1A] font-sans flex flex-col overflow-hidden select-none">
      {/* Header */}
      <header className="flex justify-between items-end px-6 md:px-10 py-6 md:py-8 border-b border-stone-200 bg-white z-20">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.3em] text-stone-400 mb-1 font-bold">Libreria Digitale</span>
          <h1 className="text-2xl md:text-4xl font-serif italic tracking-tight">VoxLibro</h1>
        </div>
        <div className="flex items-center gap-3 md:gap-4">
          <label className="bg-stone-900 text-white px-3 md:px-6 py-2 text-[9px] md:text-xs uppercase tracking-widest font-bold flex items-center gap-2 cursor-pointer transition-colors hover:bg-stone-800 rounded-sm">
             <input type="file" accept="application/pdf" onChange={handleFileUpload} className="hidden" />
             <Upload className="w-3 h-3 md:w-4 md:h-4" />
             <span className="hidden xs:inline">{file ? "Cambia PDF" : "Carica PDF"}</span>
             <span className="xs:hidden">{file ? "Cambia" : "Carica"}</span>
          </label>
          
          {file && (
            <button 
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="lg:hidden p-2 border border-stone-200 hover:bg-stone-50 rounded-sm"
            >
              <Globe className="w-5 h-5 text-stone-600" />
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 grid grid-cols-12 gap-0 overflow-hidden relative">
        <AnimatePresence mode="wait">
          {!file ? (
            <motion.section 
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="col-span-12 flex flex-col justify-center items-center text-center p-8 bg-[#FDFCFB]"
            >
              <div className="max-w-md space-y-6">
                <div className="w-16 h-16 md:w-20 md:h-20 bg-stone-50 border border-stone-200 flex items-center justify-center mx-auto mb-6 transform rotate-3">
                  <BookOpen className="w-8 h-8 md:w-10 md:h-10 text-stone-300" />
                </div>
                <h2 className="text-3xl md:text-4xl font-serif italic mb-4">Benvenuto alla tua libreria sonora</h2>
                <p className="text-stone-500 font-serif leading-relaxed italic text-base md:text-lg">
                  Carica un PDF per trasformare le pagine in un'esperienza auditiva immersiva.
                  Ideale per chi studia, lavora o semplicemente ama ascoltare.
                </p>
                <div className="pt-4 flex flex-col items-center gap-2">
                   <div className="flex flex-wrap justify-center gap-2 text-[10px] uppercase tracking-widest font-bold text-stone-300">
                      <span>Multi-lingua</span>
                      <span className="hidden sm:inline">•</span>
                      <span>Velocità variabile</span>
                      <span className="hidden sm:inline">•</span>
                      <span>AI OCR</span>
                   </div>
                </div>
              </div>
            </motion.section>
          ) : (
            <>
              {/* Mobile Sidebar Overlay */}
              <AnimatePresence>
                {isSidebarOpen && (
                  <motion.div 
                    initial={{ x: "100%" }}
                    animate={{ x: 0 }}
                    exit={{ x: "100%" }}
                    transition={{ type: "spring", damping: 25, stiffness: 200 }}
                    className="fixed inset-0 z-50 lg:hidden bg-white overflow-y-auto"
                  >
                    <div className="p-6 flex flex-col h-full bg-[#FDFCFB]">
                      <div className="flex justify-between items-center mb-8 border-b border-stone-100 pb-4">
                        <span className="text-[10px] uppercase tracking-widest font-bold text-stone-400">Impostazioni Lettura</span>
                        <button onClick={() => setIsSidebarOpen(false)} className="p-2 -mr-2">
                          <ChevronRight className="w-6 h-6 text-stone-600" />
                        </button>
                      </div>

                      <div className="space-y-10">
                        {/* Speed Control Mobile */}
                        <div className="space-y-4">
                          <div className="flex justify-between items-center">
                            <h3 className="text-[11px] uppercase tracking-widest font-bold">Velocità</h3>
                            <span className="text-xs font-mono bg-stone-100 px-2 py-1 font-bold">{speed.toFixed(1)}x</span>
                          </div>
                          <input 
                            type="range" min="0.5" max="2.5" step="0.1" value={speed}
                            onChange={(e) => setSpeed(parseFloat(e.target.value))}
                            className="w-full h-2 bg-stone-200 accent-stone-900 rounded-full appearance-none outline-none"
                          />
                        </div>

                        {/* OCR Mobile */}
                        <div className="p-5 bg-stone-50 border border-stone-200 space-y-3">
                          <h3 className="text-[10px] uppercase tracking-widest font-bold text-stone-900">Riconoscimento AI OCR</h3>
                          <p className="text-[11px] text-stone-500 font-serif italic italic leading-relaxed">Pagine con immagini o scansioni? Trasformale in testo ora.</p>
                          <button 
                            onClick={() => { handleOcr(); setIsSidebarOpen(false); }}
                            disabled={isOcrLoading || isReading}
                            className="w-full py-4 bg-stone-900 text-white text-[10px] uppercase tracking-widest font-bold flex items-center justify-center gap-2"
                          >
                            {isOcrLoading ? <Loader2 className="w-3 h-3 animate-spin"/> : <ScanEye className="w-4 h-4"/>}
                            {isOcrLoading ? "Scansione..." : "Attiva OCR AI"}
                          </button>
                        </div>

                        {/* Voice Mobile */}
                        <div className="space-y-4">
                          <h3 className="text-[11px] uppercase tracking-widest font-bold">Motore Vocale</h3>
                          <select 
                            value={selectedVoice?.voiceURI}
                            onChange={(e) => {
                              const v = voices.find(v => v.voiceURI === e.target.value);
                              if (v) setSelectedVoice(v);
                            }}
                            className="w-full bg-stone-50 border border-stone-200 p-4 text-[11px] font-sans rounded-none"
                          >
                            {voices.map((voice, idx) => (
                              <option key={idx} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      
                      <button 
                        onClick={() => setIsSidebarOpen(false)}
                        className="mt-auto w-full py-5 border-t border-stone-200 text-xs uppercase tracking-widest font-bold text-stone-400"
                      >
                        Torna alla lettura
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Left Sidebar - Removed for more space, moved info to right/mobile */}
              
              {/* Center: Reader Interface */}
              <section className="col-span-12 lg:col-span-9 flex flex-col items-center justify-start p-1 md:p-4 lg:p-6 overflow-hidden bg-white">
                <div className="w-full max-w-[1200px] h-full flex flex-col">
                  {isLoading ? (
                    <div className="flex-1 flex flex-col items-center justify-center gap-4">
                       <Loader2 className="w-12 h-12 animate-spin text-stone-900" />
                       <span className="text-base uppercase tracking-[0.3em] font-bold text-stone-400">Analisi Testuale in corso...</span>
                    </div>
                  ) : (
                    <>
                      <div className="mb-4 shrink-0 px-4">
                        <div className="flex items-center justify-between mb-2">
                           <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-bold italic">
                              Frammento {currentIndex + 1} di {chunks.length || '?'}
                           </span>
                           <div className="flex items-center gap-4">
                            {isOcrLoading && (
                              <span className="flex items-center gap-2 text-[9px] text-stone-500 animate-pulse uppercase tracking-widest font-bold bg-stone-100 px-2 py-0.5 rounded-full">
                                <Sparkles className="w-3 h-3" />
                                Analisi AI Attiva
                              </span>
                            )}
                            <span className="hidden sm:inline text-[9px] uppercase tracking-widest font-bold text-stone-300">Editoriale</span>
                           </div>
                        </div>
                        <h2 className="text-2xl md:text-4xl lg:text-5xl font-serif leading-[1.2] mt-0 break-words text-stone-900 line-clamp-1" title={file.name}>{file.name}</h2>
                      </div>
                      
                      <div className="relative flex-1 flex flex-col min-h-0 overflow-hidden">
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 md:p-8 lg:p-12 scroll-smooth">
                          {chunks.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-center space-y-6">
                               <ScanEye className="w-16 h-16 text-stone-100" />
                               <p className="text-stone-300 font-serif italic text-xl max-w-sm">Nessun testo rilevato. Usa il pulsante "Scansiona con AI".</p>
                            </div>
                          ) : (
                            <div className="space-y-6">
                              {chunks.map((chunk, idx) => (
                                <p 
                                  key={idx}
                                  id={`chunk-${idx}`}
                                  className={cn(
                                    "text-2xl md:text-3xl lg:text-4xl xl:text-5xl font-serif leading-[1.6] cursor-pointer transition-all duration-700 p-6 md:p-10 rounded-xl",
                                    currentIndex === idx 
                                      ? "bg-stone-50 text-stone-950 border-l-[8px] border-stone-900 pl-8 md:pl-12 lg:pl-14 font-medium" 
                                      : "text-stone-100 hover:text-stone-200"
                                  )}
                                  onClick={() => handlePlayPage(idx)}
                                >
                                  {chunk}
                                </p>
                              ))}
                              <div className="h-[40vh]" />
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </section>

              {/* Right Sidebar: Controls */}
              <aside className="hidden lg:flex lg:col-span-3 border-l border-stone-100 bg-[#FBF9F6] p-8 flex-col overflow-y-auto custom-scrollbar">
                {/* Document Preview in Right Sidebar now */}
                <div className="mb-12 border-b border-stone-200 pb-8">
                  <h2 className="text-[10px] uppercase tracking-widest text-stone-500 mb-6 font-bold flex items-center gap-2">
                    <BookOpen className="w-3 h-3" />
                    Libreria
                  </h2>
                  <div className="w-32 aspect-[3/4] bg-stone-200 mb-6 shadow-md border border-stone-300 relative flex items-center justify-center overflow-hidden rotate-2">
                      <div className="absolute inset-0 bg-stone-100/50 flex items-center justify-center">
                        <ScanEye className="w-12 h-12 text-stone-300 opacity-20" />
                      </div>
                  </div>
                  <p className="text-sm font-serif italic mb-1 leading-tight line-clamp-2">{file.name}</p>
                </div>
                {/* OCR AI Button Moved here */}
                <div className="p-4 bg-white border border-stone-200 mb-10 shadow-sm">
                  <h3 className="text-[10px] uppercase tracking-widest font-bold mb-3 flex items-center gap-2">
                      <Sparkles className="w-3 h-3 text-stone-400" />
                      Riconoscimento AI
                  </h3>
                  <button 
                    onClick={handleOcr}
                    disabled={isOcrLoading || isReading}
                    className={cn(
                      "w-full py-3 text-[10px] uppercase tracking-widest font-bold flex items-center justify-center gap-2 transition-all",
                      isOcrLoading 
                        ? "bg-stone-50 text-stone-300" 
                        : "bg-stone-900 text-white hover:bg-stone-800"
                    )}
                  >
                    {isOcrLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ScanEye className="w-4 h-4" />}
                    {isOcrLoading ? "Scansione..." : "Attiva OCR AI"}
                  </button>
                </div>

                {/* Voice Speed */}
                <div className="mb-10">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-[11px] uppercase tracking-widest font-bold">Velocità Lettura</h3>
                    <span className="text-xs font-mono bg-stone-100 px-2 py-1 italic font-bold tracking-tighter">{speed.toFixed(1)}x</span>
                  </div>
                  <input 
                    type="range"
                    min="0.5"
                    max="2.5"
                    step="0.1"
                    value={speed}
                    onChange={(e) => setSpeed(parseFloat(e.target.value))}
                    className="w-full h-1 bg-stone-100 accent-stone-900 cursor-pointer appearance-none rounded-full"
                  />
                  <div className="flex justify-between mt-3 text-[9px] text-stone-400 font-mono uppercase tracking-[0.1em]">
                    <span>Lento</span>
                    <span>Standard</span>
                    <span>Veloce</span>
                  </div>
                </div>

                {/* Voice Selection */}
                <div className="flex-1">
                  <h3 className="text-[11px] uppercase tracking-widest font-bold mb-4">Motore Vocale</h3>
                  <div className="space-y-4">
                    <div className="relative">
                      <select 
                        value={selectedVoice?.voiceURI}
                        onChange={(e) => {
                          const v = voices.find(v => v.voiceURI === e.target.value);
                          if (v) setSelectedVoice(v);
                        }}
                        className="w-full bg-stone-50 border border-stone-200 p-3 text-[11px] focus:outline-none focus:border-stone-900 appearance-none font-sans"
                      >
                        {voices.map((voice, idx) => (
                          <option key={idx} value={voice.voiceURI}>
                            {voice.name} ({voice.lang})
                          </option>
                        ))}
                      </select>
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                         <ChevronRight className="w-3 h-3 rotate-90 text-stone-400" />
                      </div>
                    </div>
                  </div>

                  <div className="mt-10">
                     <div className="flex items-center gap-2 mb-4">
                       <Globe className="w-3 h-3 text-stone-400" />
                       <h3 className="text-[11px] uppercase tracking-widest font-bold text-stone-400">Accenti Regionali</h3>
                     </div>
                     <div className="grid grid-cols-2 gap-2">
                       {['it-IT', 'en-GB', 'en-US', 'fr-FR', 'de-DE', 'es-ES'].map(lang => (
                         <button 
                           key={lang}
                           onClick={() => {
                             const v = voices.find(v => v.lang.startsWith(lang.split('-')[0]));
                             if (v) setSelectedVoice(v);
                           }}
                           className={cn(
                             "px-2 py-2 text-[10px] text-center border transition-all truncate uppercase tracking-tighter italic",
                             selectedVoice?.lang.startsWith(lang.split('-')[0]) 
                               ? "border-stone-900 bg-stone-900 text-white font-bold" 
                               : "border-stone-50 bg-stone-50 text-stone-400 hover:border-stone-200"
                           )}
                         >
                           {lang.split('-')[1]}
                         </button>
                       ))}
                     </div>
                  </div>
                </div>

                {/* Aesthetic Texture Toggle */}
                <div className="mt-auto border-t border-stone-100 pt-8">
                  <h3 className="text-[11px] uppercase tracking-widest font-bold mb-4">Modalità Visiva</h3>
                  <div className="flex gap-4">
                    <div className="flex-1 flex flex-col items-center p-4 bg-stone-900 text-white border border-stone-900 cursor-pointer shadow-lg shadow-stone-200">
                       <span className="text-[10px] font-bold tracking-widest">EDITORIALE</span>
                    </div>
                    <div className="flex-1 flex flex-col items-center p-4 border border-stone-100 text-stone-300 cursor-not-allowed">
                       <span className="text-[10px] font-bold tracking-widest">MINIMALE</span>
                    </div>
                  </div>
                </div>
              </aside>
            </>
          )}
        </AnimatePresence>
      </main>

      {/* Footer Player */}
      <footer className="h-20 md:h-16 border-t border-stone-100 flex items-center px-4 md:px-8 gap-4 md:gap-10 bg-white shrink-0 z-20 shadow-[-10px_0_30px_rgba(0,0,0,0.02)]">
        <div className="flex items-center gap-4 border-r border-stone-50 pr-6">
           <button 
            disabled={!file || currentIndex === 0}
            onClick={() => handlePlayPage(Math.max(0, currentIndex - 1))}
            className="w-8 h-8 rounded-full border border-stone-100 flex items-center justify-center hover:bg-stone-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
           >
            <ChevronLeft className="w-4 h-4" />
           </button>
           
           <button 
            disabled={!file || chunks.length === 0}
            onClick={toggleReading}
            className="w-10 h-10 md:w-11 md:h-11 bg-stone-900 text-white rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105 active:scale-95 disabled:opacity-20 disabled:grayscale"
           >
            {isReading ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
           </button>

           <button 
            disabled={!file || currentIndex === chunks.length - 1}
            onClick={() => handlePlayPage(Math.min(chunks.length - 1, currentIndex + 1))}
            className="w-8 h-8 rounded-full border border-stone-100 flex items-center justify-center hover:bg-stone-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
           >
            <ChevronRight className="w-4 h-4" />
           </button>
        </div>
        
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex justify-between text-[9px] font-mono text-stone-400 mb-1.5 uppercase tracking-[0.1em] font-bold">
            <span className="italic truncate max-w-[150px]">{file ? file.name : "VoxLibro"}</span>
            <span className="hidden sm:inline opacity-40">Capitolo {currentIndex + 1}</span>
          </div>
          <div className="h-[2px] bg-stone-50 w-full relative overflow-hidden rounded-full">
            <motion.div 
              className="absolute h-full bg-stone-900"
              initial={{ width: 0 }}
              animate={{ width: chunks.length > 0 ? `${((currentIndex + 1) / chunks.length) * 100}%` : 0 }}
              transition={{ type: "spring", stiffness: 50 }}
            />
          </div>
        </div>

        <div className="hidden lg:flex items-center gap-4 pl-6 shrink-0 h-full">
          <div className="flex flex-col text-right">
            <span className="text-[10px] text-stone-400 uppercase tracking-widest font-bold">Volume Atmosfera</span>
            <span className="text-sm font-mono font-bold italic tracking-tighter whitespace-nowrap text-stone-900">DINAMICO</span>
          </div>
          <div className="flex items-center gap-1">
             {[...Array(6)].map((_, i) => (
               <div 
                key={i} 
                className={cn(
                  "w-1 bg-stone-900 rounded-full transition-all duration-300",
                  isReading ? "animate-pulse" : "opacity-30"
                )} 
                style={{ 
                  height: `${isReading ? Math.random() * 24 + 4 : 8}px`,
                  animationDelay: `${i * 0.1}s`
                }} 
               />
             ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
