/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Cpu, MousePointer2, Zap, Info, Code, Layout, Play, RotateCcw, Flame, Thermometer, AlertTriangle, ShieldCheck, HelpCircle, Volume2 } from 'lucide-react';

// --- Constants & Types ---

const TARGET_QUESTIONS = 200;
const IR_TARGET_SECONDS = 11 * 3600; // 11 Hours in seconds

interface HardwareState {
  questions: number;
  irDetected: boolean;
  irProgress: number; 
  timerSeconds: number;
  irDistance: number; 
  questionTimerSeconds: number; 
  lastQuestionTime: number; // T2
  sittingTime: number; // Current sitting session
  lastSittingTime: number; // For display when standing
  isUploading: boolean;
  buttonHoldTime: number; 
  // New S, R & Reset variables
  solutions: number;
  revisions: number;
  avgTimeResetVal: number;
  avgQuestionsResetVal: number;
  btn14HoldTime: number;
  consecutiveStrikes: number;
}

// --- Components ---

/**
 * Simulated OLED Screen
 * Designed to look like a 128x64 monochrome OLED
 */
const SimulatedOLED: React.FC<{ 
  state: HardwareState; 
  temperature: number; 
  isPinConflict: boolean;
  breakType: 'SB' | 'LB' | '2H' | null;
  breakSecondsRemaining: number;
  nightModeSecondsRemaining: number;
  gpio34HoldTime: number;
  isGpio34Pressed: boolean;
  alarmActiveSeconds: number;
  isTheoryMode: boolean;
  theorySecondsRemaining: number;
}> = ({ state, temperature, isPinConflict, breakType, breakSecondsRemaining, nightModeSecondsRemaining, gpio34HoldTime, isGpio34Pressed, alarmActiveSeconds, isTheoryMode, theorySecondsRemaining }) => {
  const questionProgress = ((state.questions + state.solutions + state.revisions) / TARGET_QUESTIONS) * 100;
  const irProgress = (state.timerSeconds / IR_TARGET_SECONDS) * 100;
  
  const formatTime = (totalSeconds: number, forceHours: boolean = false) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (forceHours || hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const activeQuestionsAndSolutions = Math.max(0, (state.questions + state.solutions) - state.avgQuestionsResetVal);
  const activeTimerSeconds = Math.max(0, state.timerSeconds - state.avgTimeResetVal);
  const avgTime = activeQuestionsAndSolutions > 0 ? formatTime(Math.floor(activeTimerSeconds / activeQuestionsAndSolutions)) : "0:00";

  return (
    <div className="w-64 h-48 bg-black border-4 border-gray-800 rounded-lg p-2 flex flex-col font-mono text-[#39FF14] shadow-2xl relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%]" />
      
      <div className="z-10 flex flex-col h-full space-y-1">
        {temperature >= 75 ? (
          <div className="flex flex-col items-center justify-center h-full space-y-2 text-red-500 animate-pulse text-center">
            <span className="text-sm font-extrabold tracking-widest text-[#39FF14]">⚠️ OVERHEAT ⚠️</span>
            <span className="text-[9px] text-[#39FF14] uppercase">Pin 13 Short Circuit</span>
            <span className="text-xl font-bold bg-red-950/80 px-2 py-0.5 border border-[#39FF14] rounded text-[#39FF14]">{temperature}°C</span>
            <span className="text-[7px] text-[#39FF14] opacity-80 leading-tight">CHANGE pinMode(13, INPUT)<br/>AND POWER WITH 5V RAIL</span>
          </div>
        ) : state.isUploading ? (
          <div className="flex flex-col items-center justify-center h-full space-y-4">
            <div className="text-lg animate-pulse">UPLOADING...</div>
            <div className="w-full h-2 border border-[#39FF14]"><div className="h-full bg-[#39FF14] transition-all duration-[2000ms]" style={{width:'100%'}} /></div>
          </div>
        ) : (
          <>
            {/* Line 1: Q Summary */}
            <div className="flex justify-between items-baseline px-1 h-3 text-[10px]">
              <div className="flex gap-2">
                <span className="font-bold">Q={state.questions}</span>
                <span className="font-bold">S={state.solutions}</span>
                <span className="font-bold">R={state.revisions}</span>
              </div>
              <span className="font-bold opacity-70 flex items-center gap-1">
                200
              </span>
            </div>
 
            {/* Line 2: Graph Q (Thinner) */}
            <div className="px-1 h-1.5 mb-1.5">
              <div className="w-full h-full border border-[#39FF14] relative bg-black">
                 <div className="h-full bg-[#39FF14]" style={{ width: `${Math.min(questionProgress, 100)}%` }} />
              </div>
            </div>
 
            {/* Line 3: TOT Summary */}
            <div className="flex justify-between items-baseline px-1 h-3">
              <div className="flex items-baseline gap-1">
                <span className="text-[7px] opacity-60">TOT:</span>
                <span className="text-[11px] font-bold">{formatTime(state.timerSeconds, true)}</span>
              </div>
            </div>
 
            {/* Line 4: SIT & Target / Break Countdown / Theory Countdown */}
            <div className="flex justify-between items-center px-1 h-4">
               {isTheoryMode ? (
                 <div className="px-1 rounded-sm text-[8px] bg-purple-600 text-white font-bold flex items-center gap-1 animate-pulse">
                   <span>THR:</span>
                   <span>{formatTime(theorySecondsRemaining)}</span>
                 </div>
               ) : breakType !== null ? (
                 <div className="px-1 rounded-sm text-[8px] bg-amber-500 text-black font-bold flex items-center gap-1 animate-pulse">
                   <span>BRK:</span>
                   <span>{breakType} {formatTime(breakSecondsRemaining)}</span>
                 </div>
               ) : (
                 <div className={`px-1 rounded-sm text-[8px] flex items-center gap-1 ${state.irDetected ? 'bg-[#39FF14] text-black font-bold' : 'border border-[#39FF14]/30'}`}>
                   <span>SIT:</span>
                   <span>{state.irDetected ? formatTime(state.sittingTime) : formatTime(state.lastSittingTime)}</span>
                 </div>
               )}
               <span className="text-[10px] font-bold">11</span>
            </div>

            {/* Line 5: Graph T (Thinner) */}
            <div className="px-1 h-1.5 mt-0.5 mb-1.5">
              <div className="w-full h-full border border-[#39FF14] relative bg-black">
                 <div className="h-full bg-[#39FF14] opacity-80" style={{ width: `${Math.min(irProgress, 100)}%` }} />
              </div>
            </div>

            {/* Line 6: T2 & T */}
            <div className="flex justify-between px-1 h-3 text-[10px] font-bold">
               <div className="flex gap-1 items-baseline">
                 <span className="text-[6px] opacity-50 italic">T2:</span>
                 <span>{formatTime(state.lastQuestionTime)}</span>
               </div>
               <div className="flex gap-1 items-baseline">
                 <span className="text-[6px] opacity-50 italic">T:</span>
                 <span>{formatTime(state.questionTimerSeconds)}</span>
               </div>
            </div>

            {/* Line 7: AVG */}
            <div className="mt-auto flex justify-between items-center pb-0.5 pt-0.5 border-t border-[#39FF14]/10 px-1">
               <div className="flex items-baseline gap-2">
                 <span className="text-[6px] opacity-60 uppercase">Avg:</span>
                 <span className="text-[11px] font-bold">{avgTime}</span>
               </div>
               {state.consecutiveStrikes > 0 && (
                 <div className="flex items-baseline gap-1 text-yellow-400 font-extrabold animate-pulse">
                   <span className="text-[6px] opacity-70">K:</span>
                   <span className="text-[11px]">{state.consecutiveStrikes}</span>
                 </div>
               )}
            </div>

            {/* Absent / Alarm indicators overlay */}
            {alarmActiveSeconds > 0 && (
              <div className="absolute inset-0 bg-black flex flex-col items-center justify-center text-center z-30">
                <span className={`text-[10px] font-bold tracking-wider ${alarmActiveSeconds >= 300 ? 'text-red-500 animate-bounce' : 'text-amber-500 animate-pulse'}`}>
                  {alarmActiveSeconds >= 300 ? '!!! DANGER !!!' : '! WARNING !'}
                </span>
                <span className="text-[8px] opacity-75 mt-1 text-[#39FF14]">
                  {alarmActiveSeconds >= 300 ? 'ABSENT FOR 5m+' : 'STUDY DESK EMPTY'}
                </span>
                <span className="text-[7px] text-gray-500 mt-0.5 font-mono">
                  ({alarmActiveSeconds}s)
                </span>
              </div>
            )}

            {/* Pulse Indicator for Reset */}
            {state.buttonHoldTime > 0 && (
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-red-600 text-white px-2 py-1 text-[8px] font-bold rounded animate-pulse z-20">
                RESET IN {(5 - state.buttonHoldTime/1000).toFixed(1)}s
              </div>
            )}

            {/* Action Indicators for GPIO 14 */}
            {state.btn14HoldTime > 0 && (
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-blue-600 text-white px-2 py-1 text-[8px] font-bold rounded animate-pulse z-20">
                {state.btn14HoldTime < 2000 ? (
                  `S (+1) ON RELEASE`
                ) : state.btn14HoldTime < 4000 ? (
                  `R (+1) ON RELEASE`
                ) : (
                  `RESET AVG ON RELEASE`
                )}
              </div>
            )}

            {/* Break Indicators for GPIO 34 */}
            {isGpio34Pressed && gpio34HoldTime >= 1500 && (
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-amber-600 text-white px-2 py-1 text-[8px] font-bold rounded animate-pulse z-20 text-center">
                {gpio34HoldTime < 3000 ? (
                  `RELEASE FOR SB`
                ) : gpio34HoldTime < 4500 ? (
                  `RELEASE FOR LB`
                ) : (
                  `RELEASE FOR 2H`
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

/**
 * Code Viewer
 * Displays the Arduino/ESP32 code for the hardware setup
 */
const CodeViewer: React.FC = () => {
  const code = `/*
 * navQtracker - Advanced Version (V2.6)
 * 1. Data Persistence (Preferences)
 * 2. Long Press (5s) Upload & Reset (Anti-click release debounce code added)
 * 3. Passive Buzzer Milestones & Alarm (GPIO 18)
 * 4. T2 (Prev Q Time) & AVG (Average Time with reset feature)
 * 5. Sitting Session Tracking (Auto-reset on stand)
 * 6. Action Button (GPIO 14) for S (Solutions), R (Revisions), & Reset AVG
 * 7. Break Button (GPIO 32 recommended, or GPIO 34) for SB (5m, hold 1.5s), LB (20m, hold 3s), & 2H (120m, hold 4.5s)
 * 8. RGB LED Module (GPIO 25=R, 26=G, 27=B) for state indicators & flashes
 * 9. Satisfying milestone buzzer beeps starting with 3 beeps and adding 1 beep per hour
 * 10. 11-Hour Silent Night Mode post-reset to mute irritating alarms
 * 11. Auto-cancel active break upon sitting down (IR sensor triggered)
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// --- CONFIGURATION ---
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
const char* serverUrl = "https://navelep.vercel.app"; 
const char* iotApiKey = "YOUR_SECRET_KEY"; 

const int BUTTON_PIN = 4;        // Question Button
const int BUTTON_2_PIN = 14;     // Action Button (Solutions, Revisions, Reset Avg)
const int BUTTON_BREAK_PIN = 32; // Break Button (GPIO 32 highly recommended as GPIO 34 lacks internal pullup on ESP32)
const int IR_PIN = 13;           // IR Sitting Sensor
const int BUZZER_PIN = 18;       // Passive Buzzer

// RGB LED Pins
const int RGB_RED_PIN = 25;
const int RGB_GRN_PIN = 26;
const int RGB_BLU_PIN = 27;

const int TARGET_Q = 200;
const long TARGET_TIME = 11L * 3600L;

// --- STATE ---
int questions = 0;
unsigned long timerSeconds = 0;
unsigned long questionTimerSeconds = 0;
unsigned long lastQuestionTime = 0; 
unsigned long sittingTime = 0;      
unsigned long lastSittingTime = 0;
unsigned long lastTimerUpdate = 0;
unsigned long buttonPressStart = 0;
bool isButtonPressed = false;
bool wasSitting = false;

// Solutions, Revisions and Reset offsets
int solutions = 0;
int revisions = 0;
int consecutiveStrikes = 0;
unsigned long alarmActiveSeconds = 0;
unsigned long avgTimeResetVal = 0;
int avgQuestionsResetVal = 0;
unsigned long button2PressStart = 0;
bool isButton2Pressed = false;

// New Break and Silent Mode State
int breakType = 0; // 0=None, 1=SB, 2=LB, 3=2H
long breakSecondsRemaining = 0;
unsigned long breakButtonPressStart = 0;
bool isBreakButtonPressed = false;

// Theory Mode State (double click break button)
bool isTheoryMode = false;
long theorySecondsRemaining = 0;
unsigned long lastBreakButtonRelease = 0;

Preferences preferences;

// RGB Color Control helper
void setRGB(bool red, bool green, bool blue) {
  digitalWrite(RGB_RED_PIN, red ? HIGH : LOW);
  digitalWrite(RGB_GRN_PIN, green ? HIGH : LOW);
  digitalWrite(RGB_BLU_PIN, blue ? HIGH : LOW);
}

// Hourly Milestone Chime - Starts at 3 simple beeps for the 1st hour,
// and adds 1 beep for each subsequent hour (+1 beep per hour), alternating high and low tones.
void playSatisfyingChime(int hours) {
  int numBeeps = hours + 2; // Hour 1 = 3 beeps, Hour 2 = 4 beeps, Hour 3 = 5 beeps, etc.
  
  for (int i = 0; i < numBeeps; i++) {
    int freq = (i % 2 == 0) ? 2400 : 1600; // Alternating high (2400Hz) and low (1600Hz) tones
    tone(BUZZER_PIN, freq, 150); // Alternating passive buzzer frequencies
    delay(300); // 150ms sound + 150ms delay
  }
}

void playSound(int type) {
  if (type == 1) { // Single Question Solved (Blue Flash)
    setRGB(false, false, true);
    tone(BUZZER_PIN, 2500, 80); 
    delay(80);
    setRGB(false, false, false);
  } else if (type == 4) { // Action S+1 Click (Green Flash)
    setRGB(false, true, false);
    tone(BUZZER_PIN, 1800, 150); 
    delay(150);
    setRGB(false, false, false);
  } else if (type == 5) { // Action R+1 Click (Purple Flash)
    setRGB(true, false, true);
    tone(BUZZER_PIN, 1200, 400); 
    delay(400);
    setRGB(false, false, false);
  } else if (type == 6) { // Reset Average Click / Double Beep
    tone(BUZZER_PIN, 3000, 100); 
    delay(120);
    tone(BUZZER_PIN, 3500, 200);
  }
}

void playStrikeFeedback(int type, int strikeCount) {
  int r = 0, g = 0, b = 0;
  int freq = 1000;
  int dur = 100;
  int interval = 250; // default interval for 2 blinks
  
  if (type == 1) { // Q (Blue)
    r = 0; g = 0; b = 1;
    freq = 2500;
    dur = 80;
  } else if (type == 4) { // S (Green)
    r = 0; g = 1; b = 0;
    freq = 1800;
    dur = 150;
  } else if (type == 5) { // R (Purple)
    r = 1; g = 0; b = 1;
    freq = 1200;
    dur = 400;
  }
  
  if (strikeCount >= 3) {
    interval = 1000; // 1 second interval for 3 or more consecutive strikes!
  }
  
  // 1. Play respective tone first
  tone(BUZZER_PIN, freq, dur);
  delay(dur + 100);
  
  // 2. Play strike tone if strikeCount > 0
  if (strikeCount > 0) {
    int beeps = strikeCount + 2;
    int baseHigh = 2800 + (strikeCount * 50);
    int baseLow = 2100 + (strikeCount * 50);
    for (int i = 0; i < beeps; i++) {
      int currentFreq = (i % 2 == 0) ? baseHigh : baseLow;
      tone(BUZZER_PIN, currentFreq, 120);
      delay(270); // 120ms sound + 150ms delay
    }
  }
  
  int count = (strikeCount > 0) ? strikeCount : 1;
  for (int i = 0; i < count; i++) {
    if (i > 0) {
      delay(interval);
    }
    setRGB(r, g, b);
    delay(dur);
    setRGB(false, false, false);
  }
}

void setup() {
  Serial.begin(115200);
  setCpuFrequencyMhz(80); // Underclock to 80MHz (lowest frequency supporting standard I2C/OLED timing) to run cold and save 66% power
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BUTTON_2_PIN, INPUT_PULLUP);
  pinMode(BUTTON_BREAK_PIN, INPUT_PULLUP);
  pinMode(IR_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  
  // Initialize RGB outputs
  pinMode(RGB_RED_PIN, OUTPUT);
  pinMode(RGB_GRN_PIN, OUTPUT);
  pinMode(RGB_BLU_PIN, OUTPUT);
  setRGB(false, false, false);
  
  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) for(;;);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.println("navQ V2.6");
  display.display();
  delay(1000);

  preferences.begin("navq", false);
  questions = preferences.getInt("q", 0);
  timerSeconds = preferences.getUInt("t", 0);
  solutions = preferences.getInt("s", 0);
  revisions = preferences.getInt("r", 0);
  avgTimeResetVal = preferences.getUInt("at", 0);
  avgQuestionsResetVal = preferences.getInt("aq", 0);
  consecutiveStrikes = 0; // K is always reset on switch-on / power boot
  
  WiFi.begin(ssid, password);
}

void saveData() {
  preferences.putInt("q", questions);
  preferences.putUInt("t", timerSeconds);
  preferences.putInt("s", solutions);
  preferences.putInt("r", revisions);
  preferences.putUInt("at", avgTimeResetVal);
  preferences.putInt("aq", avgQuestionsResetVal);
  preferences.putInt("stk", consecutiveStrikes);
}

void uploadData() {
  display.clearDisplay();
  display.setCursor(0, 10);
  display.println("UPLOADING...");
  display.display();

  if (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(ssid, password);
    int retry = 0;
    while (WiFi.status() != WL_CONNECTED && retry < 10) { delay(500); retry++; } // 5s max attempt
  }

  bool success = false;
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    String url = String(serverUrl) + "/api/iot/toggle?key=" + String(iotApiKey);
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    StaticJsonDocument<200> doc;
    doc["questions"] = questions;
    doc["hours"] = (float)timerSeconds / 3600.0;
    doc["solutions"] = solutions;
    doc["revisions"] = revisions;
    String json;
    serializeJson(doc, json);
    int code = http.POST(json);
    if (code >= 200 && code < 300) success = true;
    http.end();
  }

  if (success) {
    display.println("SUCCESS!");
  } else {
    display.println("SAVED LOCALLY!");
  }
  
  // ALWAYS RESET AFTER 5s HOLD
  questions = 0; 
  timerSeconds = 0; 
  questionTimerSeconds = 0;
  solutions = 0;
  revisions = 0;
  avgTimeResetVal = 0;
  avgQuestionsResetVal = 0;
  breakType = 0;
  breakSecondsRemaining = 0;
  saveData();
  
  display.display();
  delay(2000);
}

void loop() {
  bool currentButtonState = digitalRead(BUTTON_PIN);
  bool currentButton2State = digitalRead(BUTTON_2_PIN);
  bool currentBreakButtonState = digitalRead(BUTTON_BREAK_PIN);
  bool isSittingNow = (digitalRead(IR_PIN) == LOW);

  // BUTTON 1 (GPIO 4) HANDLER
  if (currentButtonState == LOW && !isButtonPressed) {
    isButtonPressed = true;
    buttonPressStart = millis();
  } 
  else if (currentButtonState == HIGH && isButtonPressed) {
    unsigned long held = millis() - buttonPressStart;
    if (held < 5000) { 
      bool isStrike = (questionTimerSeconds <= 240);
      if (isStrike) {
        consecutiveStrikes++;
      } else {
        consecutiveStrikes = 0;
      }
      questions++; lastQuestionTime = questionTimerSeconds; 
      questionTimerSeconds = 0; saveData();
      playStrikeFeedback(1, isStrike ? consecutiveStrikes : 0);
    }
    isButtonPressed = false;
  }

  if (isButtonPressed && (millis() - buttonPressStart >= 5000)) {
    uploadData();
    // Wait for button release to prevent button-up click register
    while (digitalRead(BUTTON_PIN) == LOW) { delay(10); }
    isButtonPressed = false; 
  }

  // BUTTON 2 (GPIO 14) HANDLER
  if (currentButton2State == LOW && !isButton2Pressed) {
    isButton2Pressed = true;
    button2PressStart = millis();
  }
  else if (currentButton2State == HIGH && isButton2Pressed) {
    unsigned long held = millis() - button2PressStart;
    if (held < 2000) { // Click < 2s -> Solution + 1 (Green Flash)
      bool isStrike = (questionTimerSeconds <= 240);
      if (isStrike) {
        consecutiveStrikes++;
      } else {
        consecutiveStrikes = 0;
      }
      solutions++;
      lastQuestionTime = questionTimerSeconds;
      questionTimerSeconds = 0;
      saveData();
      playStrikeFeedback(4, isStrike ? consecutiveStrikes : 0);
    }
    else if (held >= 2000 && held < 4000) { // Hold 2-4s -> Revision + 1 (Purple Flash)
      bool isStrike = (questionTimerSeconds <= 240);
      if (isStrike) {
        consecutiveStrikes++;
      } else {
        consecutiveStrikes = 0;
      }
      revisions++;
      lastQuestionTime = questionTimerSeconds;
      questionTimerSeconds = 0;
      saveData();
      playStrikeFeedback(5, isStrike ? consecutiveStrikes : 0);
    }
    else if (held >= 4000) { // Hold 4s+ -> Reset Average Time counter
      avgTimeResetVal = timerSeconds;
      avgQuestionsResetVal = questions + solutions;
      lastQuestionTime = questionTimerSeconds;
      questionTimerSeconds = 0;
      saveData();
      playSound(6);
    }
    isButton2Pressed = false;
  }

  // BREAK BUTTON HANDLER (with Double Click for Theory Mode)
  if (currentBreakButtonState == LOW && !isBreakButtonPressed) {
    isBreakButtonPressed = true;
    breakButtonPressStart = millis();
  }
  else if (currentBreakButtonState == HIGH && isBreakButtonPressed) {
    unsigned long held = millis() - breakButtonPressStart;
    if (held < 1500) {
      unsigned long now = millis();
      if (now - lastBreakButtonRelease < 500) { // Double click detected!
        isTheoryMode = true;
        theorySecondsRemaining = 20 * 60; // 20 minutes (1200 seconds)
        breakType = 0; // Cancel break
        breakSecondsRemaining = 0;
        // Play theory active happy sound
        tone(BUZZER_PIN, 1800, 100);
        delay(120);
        tone(BUZZER_PIN, 2200, 100);
        delay(120);
        tone(BUZZER_PIN, 2600, 150);
      }
      lastBreakButtonRelease = now;
    } else if (held >= 1500 && held < 3000) { // Hold 1.5s to 3s -> 5m Short Break (SB)
      isTheoryMode = false;
      theorySecondsRemaining = 0;
      breakType = 1;
      breakSecondsRemaining = 5 * 60;
      tone(BUZZER_PIN, 1500, 120);
      delay(140);
      tone(BUZZER_PIN, 2000, 150);
    } else if (held >= 3000 && held < 4500) { // Hold 3s to 4.5s -> 20m Long Break (LB)
      isTheoryMode = false;
      theorySecondsRemaining = 0;
      breakType = 2;
      breakSecondsRemaining = 20 * 60;
      tone(BUZZER_PIN, 1000, 150);
      delay(160);
      tone(BUZZER_PIN, 1400, 150);
      delay(160);
      tone(BUZZER_PIN, 1800, 200);
    } else if (held >= 4500) { // Hold 4.5s+ -> 2h Break (2H)
      isTheoryMode = false;
      theorySecondsRemaining = 0;
      breakType = 3;
      breakSecondsRemaining = 120 * 60;
      tone(BUZZER_PIN, 1000, 120);
      delay(140);
      tone(BUZZER_PIN, 1200, 120);
      delay(140);
      tone(BUZZER_PIN, 1500, 150);
      delay(160);
      tone(BUZZER_PIN, 1800, 150);
    }
    isBreakButtonPressed = false;
  }

  // Real-time alarm and LED flasher (runs every 1 second)
  if (millis() - lastTimerUpdate >= 1000) {
    // Decrement remaining timers
    if (breakSecondsRemaining > 0) {
      breakSecondsRemaining--;
      if (breakSecondsRemaining == 0) {
        breakType = 0;
        tone(BUZZER_PIN, 1200, 300);
        delay(320);
        tone(BUZZER_PIN, 1000, 300);
      }
    }

    if (theorySecondsRemaining > 0) {
      theorySecondsRemaining--;
      if (theorySecondsRemaining == 0) {
        isTheoryMode = false;
        tone(BUZZER_PIN, 2000, 150);
        delay(170);
        tone(BUZZER_PIN, 2400, 200);
      }
    }

    if (isSittingNow) {
      alarmActiveSeconds = 0;
      // Auto detect sit -> break is over!
      if (breakType > 0) {
        breakType = 0;
        breakSecondsRemaining = 0;
        tone(BUZZER_PIN, 2000, 100);
        delay(120);
        tone(BUZZER_PIN, 1800, 100);
      }
      timerSeconds++; questionTimerSeconds++; sittingTime++;
      if (!wasSitting) sittingTime = 0;
      
      if (!isTheoryMode) {
        // Exactly at 3 minutes (180s) play 2 beeps and pink LED light twice
        if (questionTimerSeconds == 180) {
          for (int i = 0; i < 2; i++) {
            setRGB(true, false, true); // Pink/Purple (Red + Blue)
            tone(BUZZER_PIN, 2000, 150);
            delay(150);
            setRGB(false, false, false);
            delay(150);
          }
        }
        
        // Alert if solving current question/solution is taking too long
        if (questionTimerSeconds > 600) {
          // After 10 minutes: red blink + a little irritating sound, both in red
          if (questionTimerSeconds % 3 == 0) {
            setRGB(true, false, false);
            tone(BUZZER_PIN, 1500, 150); // Softly irritating tone (much softer than stand-up alarm)
          } else {
            setRGB(false, false, false);
          }
        } else if (questionTimerSeconds >= 420) { // Starts at 7 minutes (420s) up to 10 minutes (600s)
          // Quiet blinking light in red, without sound
          if (questionTimerSeconds % 3 == 0) {
            setRGB(true, false, false);
          } else {
            setRGB(false, false, false);
          }
        } else {
          // Mute red blink if under 7 minutes and sitting
          setRGB(false, false, false);
        }
      } else {
        // If in theory mode and sitting, keep LED off/normal
        setRGB(false, false, false);
      }
      
      // Hourly milestones - play the milestone chime
      if (timerSeconds > 0 && timerSeconds % 3600 == 0) {
        int hr = timerSeconds / 3600;
        playSatisfyingChime(hr); 
      }
    } else {
      if (wasSitting) { lastSittingTime = sittingTime; sittingTime = 0; }
      
      // Stop Theory Mode when user stands up
      if (isTheoryMode) {
        isTheoryMode = false;
        theorySecondsRemaining = 0;
        tone(BUZZER_PIN, 1000, 150);
        delay(170);
        tone(BUZZER_PIN, 800, 150);
      }
      
      // Stand-up and Alarm Logic: trigger annoying alarm and flashing Red LED
      // strictly if not sitting, break has expired, and not currently uploading
      if (breakSecondsRemaining <= 0) {
        alarmActiveSeconds++;
        
        // 4Hz normally, escalates to 8Hz after 15 minutes (900 seconds) to increase irritation
        bool isUrgent = (alarmActiveSeconds >= 900);
        int beeps = isUrgent ? 8 : 4;
        
        for (int i = 0; i < beeps; i++) {
          setRGB(true, false, false);
          tone(BUZZER_PIN, 2600, isUrgent ? 60 : 100);
          delay(isUrgent ? 65 : 120);
          setRGB(false, false, false);
          delay(isUrgent ? 60 : 130);
        }
      } else {
        alarmActiveSeconds = 0;
        setRGB(false, false, false); // Keep LED quiet during valid breaks
      }
    }
    wasSitting = isSittingNow;
    lastTimerUpdate = millis();
    if (timerSeconds % 60 == 0) saveData();
  }

  // OLED Layout Optimised V2.5
  display.clearDisplay();
  display.setTextSize(1);
  
  // Line 1: Q, S, R Summary (y=0)
  display.setCursor(0, 0);
  display.print("Q="); display.print(questions);
  display.setCursor(45, 0);
  display.print("S="); display.print(solutions);
  display.setCursor(85, 0);
  display.print("R="); display.print(revisions);
  display.setCursor(110, 0);
  display.print("200");

  // Line 2: Graph Q (y=9, h=4)
  display.drawRect(0, 9, 128, 4, SSD1306_WHITE);
  display.fillRect(0, 9, map(min(questions + solutions + revisions, TARGET_Q), 0, TARGET_Q, 0, 128), 4, SSD1306_WHITE);

  // Line 3: TOT Header (y=16)
  display.setCursor(0, 16);
  display.print("TOT: ");
  display.print(timerSeconds/3600); display.print(":");
  if((timerSeconds%3600)/60 < 10) display.print("0");
  display.print((timerSeconds%3600)/60); display.print(":");
  if(timerSeconds%60 < 10) display.print("0");
  display.print(timerSeconds%60);

  // Line 4: SIT / THR / BRK (y=26)
  display.setCursor(0, 26);
  if (isTheoryMode) {
    display.print("THR: ");
    display.print(theorySecondsRemaining/60); display.print("m ");
    display.print(theorySecondsRemaining%60); display.print("s");
  } else if (breakType > 0) {
    display.print("BRK: ");
    if (breakType == 1) display.print("SB ");
    else if (breakType == 2) display.print("LB ");
    else if (breakType == 3) display.print("2H ");
    display.print(breakSecondsRemaining/60); display.print("m");
  } else {
    display.print("SIT: "); 
    if(isSittingNow) {
      display.print(sittingTime/60); display.print("m ");
      display.print(sittingTime%60); display.print("s");
    } else {
      display.print(lastSittingTime/60); display.print("m (ST)");
    }
  }
  display.setCursor(115, 26);
  display.print("11");

  // Line 5: Graph T (y=34, h=4)
  display.drawRect(0, 34, 128, 4, SSD1306_WHITE);
  display.fillRect(0, 34, map(min(timerSeconds, (unsigned long)TARGET_TIME), 0, TARGET_TIME, 0, 128), 4, SSD1306_WHITE);

  // Line 6: T2 | T (y=41)
  display.setCursor(0, 41);
  display.print("T2:"); display.print(lastQuestionTime/60); display.print(":"); 
  if(lastQuestionTime%60 < 10) display.print("0");
  display.print(lastQuestionTime%60);
  
  display.setCursor(80, 41);
  display.print("T:"); display.print(questionTimerSeconds/60); display.print(":"); 
  if(questionTimerSeconds%60 < 10) display.print("0");
  display.print(questionTimerSeconds%60);

  // Line 7: AVG (Bottom) (y=52)
  display.setCursor(0, 52); 
  display.print("AVG: ");
  int activeQ = (questions + solutions) - avgQuestionsResetVal;
  if(activeQ > 0) {
    int avg = (timerSeconds - avgTimeResetVal) / activeQ;
    display.print(avg/60); display.print(":"); 
    if(avg%60 < 10) display.print("0");
    display.print(avg%60);
  } else {
    display.print("0:00");
  }

  // Put capital K on the line of average, just below T1 and T2
  if (consecutiveStrikes > 0) {
    display.setCursor(76, 52);
    display.print("K:"); display.print(consecutiveStrikes);
  }

  // Hold indicator overlays
  if (isButtonPressed) {
    int hold = (millis() - buttonPressStart) / 1000;
    if (hold >= 1) {
      display.fillRect(0, 40, 128, 24, SSD1306_BLACK); 
      display.setCursor(10, 45); 
      if (hold >= 5) display.print(">>> UPLOADING <<<");
      else { display.print("RESET IN: "); display.print(5 - hold); display.print("s"); }
    }
  } else if (isButton2Pressed) {
    int hold = (millis() - button2PressStart) / 1000;
    if (hold >= 1) {
      display.fillRect(0, 40, 128, 24, SSD1306_BLACK); 
      display.setCursor(5, 45); 
      if (hold < 2) display.print("RELEASE FOR S ");
      else if (hold >= 2 && hold < 4) display.print("RELEASE FOR R ");
      else display.print(">>> RESET AVG <<<");
    }
  } else if (isBreakButtonPressed) {
    int holdMs = millis() - breakButtonPressStart;
    if (holdMs >= 1500) {
      display.fillRect(0, 40, 128, 24, SSD1306_BLACK); 
      display.setCursor(5, 45); 
      if (holdMs < 3000) display.print("RELEASE FOR SB ");
      else if (holdMs >= 3000 && holdMs < 4500) display.print("RELEASE FOR LB ");
      else display.print("RELEASE FOR 2H ");
    }
  } else if (alarmActiveSeconds > 0) {
    display.fillRect(0, 40, 128, 24, SSD1306_BLACK); 
    display.setCursor(5, 45); 
    if (alarmActiveSeconds >= 300) {
      display.print("!!! DANGER: ABSENT !!!");
    } else {
      display.print("! WARNING: ABSENT !");
    }
  }
  display.display();
  delay(100); // Main loop runs at 10Hz to save CPU cycles and power
}
`;

  return (
    <div className="bg-gray-900 rounded-xl p-4 overflow-hidden border border-gray-700 shadow-inner">
      <div className="flex items-center justify-between mb-2 text-gray-400 text-xs uppercase tracking-widest">
        <span className="flex items-center gap-1"><Code size={14} /> Arduino Code (ESP32)</span>
        <button 
          onClick={() => navigator.clipboard.writeText(code)}
          className="hover:text-white transition-colors"
        >
          Copy
        </button>
      </div>
      <pre className="text-sm text-blue-300 font-mono overflow-x-auto p-2 bg-black/50 rounded leading-relaxed">
        {code}
      </pre>
    </div>
  );
};

/**
 * Backend Integration Guide
 */
const BackendGuide: React.FC = () => {
  return (
    <div className="space-y-6">
      <section>
        <h4 className="text-xs font-bold text-gray-500 uppercase mb-3 text-red-400">⚠️ Critical: Server Requirement</h4>
        <p className="text-xs text-gray-400 mb-2">
          The ESP32 cannot send data to a website that isn't live. You <b>MUST</b> deploy your website first and ensure the <code>serverUrl</code> in the code matches your live API address.
        </p>
      </section>

      <section>
        <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">1. WiFi Configuration</h4>
        <p className="text-xs text-gray-400 mb-2">In the Arduino code, find the <b>CONFIGURATION</b> section and update these lines:</p>
        <div className="bg-black/40 p-3 rounded font-mono text-[10px] text-blue-300 border border-gray-800">
          const char* ssid = "YourWiFiName";<br/>
          const char* password = "YourPassword";
        </div>
      </section>

      <section>
        <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">2. Server Endpoint & Security</h4>
        <p className="text-xs text-gray-400 mb-2">Set your website's API URL and the <b>IOT_API_KEY</b> for security.</p>
        <div className="bg-black/40 p-3 rounded font-mono text-[10px] space-y-1 border border-gray-800">
          <div className="text-emerald-300">const char* serverUrl = "https://navelep.vercel.app";</div>
          <div className="text-yellow-300">const char* iotApiKey = "YourSecretKey";</div>
        </div>
        <div className="mt-4 p-3 bg-blue-900/20 border border-blue-800 rounded-lg">
          <h5 className="text-[10px] font-bold text-blue-400 uppercase mb-2">How to set Key in Vercel:</h5>
          <ol className="text-[10px] text-gray-400 list-decimal ml-4 space-y-1">
            <li>Open your <b>Vercel Dashboard</b>.</li>
            <li>Click on your project (<b>navelep</b>).</li>
            <li>Go to the <b>Settings</b> tab at the top.</li>
            <li>Click <b>Environment Variables</b> in the left sidebar.</li>
            <li>Add <b>Key:</b> <code className="text-white">IOT_API_KEY</code></li>
            <li>Add <b>Value:</b> (Any password you want, e.g. <code className="text-white">suresh123</code>)</li>
            <li>Click <b>Save</b> and then <b>Redeploy</b> your site.</li>
          </ol>
        </div>
      </section>

      <section>
        <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">3. Backend Logic (Node.js)</h4>
        <p className="text-xs text-gray-400 mb-2">Your server should verify the API key and handle the data:</p>
        <div className="bg-black/40 p-3 rounded font-mono text-[10px] text-gray-300 border border-gray-800">
          {`app.post('/api/iot/toggle', (req, res) => {
  const apiKey = req.query.key;
  if (apiKey !== process.env.IOT_API_KEY) {
    return res.status(401).send('Unauthorized');
  }

  const { questions, hours } = req.body;
  console.log(\`Study Session: \${questions} Qs, \${hours} Hours\`);
  // Save to database...
  res.sendStatus(200);
});`}
        </div>
      </section>
    </div>
  );
};

interface ThermalProps {
  isPinConflict: boolean;
  setIsPinConflict: (val: boolean) => void;
  isPowerBudgetExceeded: boolean;
  setIsPowerBudgetExceeded: (val: boolean) => void;
  temperature: number;
  cpuFrequency: number;
  setCpuFrequency: (val: number) => void;
}

const ThermalDiagnostics: React.FC<ThermalProps> = ({
  isPinConflict,
  setIsPinConflict,
  isPowerBudgetExceeded,
  setIsPowerBudgetExceeded,
  temperature,
  cpuFrequency,
  setCpuFrequency
}) => {
  const getTempStatus = () => {
    if (temperature >= 75) return 'CRITICAL (Short Circuit Active)';
    if (temperature >= 50) return 'WARM (Voltage Regulator Stress)';
    return 'NORMAL (Optimal / Safe)';
  };

  return (
    <div className="space-y-6">
      <div 
        className="text-center p-5 rounded-2xl border-2 border-dashed transition-all duration-300 flex flex-col items-center justify-center gap-2 bg-black/40 shadow-inner" 
        style={{ borderColor: temperature >= 75 ? '#ef4444' : temperature >= 50 ? '#f59e0b' : '#10b981' }}
      >
        <div className="flex items-center gap-2">
          <Thermometer className={temperature >= 75 ? 'text-red-500 animate-bounce' : temperature >= 50 ? 'text-amber-500' : 'text-emerald-500'} size={24} />
          <span className="text-3xl font-mono font-extrabold tracking-tight">
            {temperature}°C
          </span>
        </div>
        <div className={`text-[10px] font-bold uppercase tracking-widest ${temperature >= 75 ? 'text-red-400' : temperature >= 50 ? 'text-amber-400' : 'text-emerald-400'}`}>
          {getTempStatus()}
        </div>
        <div className="w-full bg-gray-800 rounded-full h-2.5 mt-1 overflow-hidden">
          <div 
            className={`h-full transition-all duration-500 ${temperature >= 75 ? 'bg-red-500' : temperature >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
            style={{ width: `${Math.min(100, (temperature / 100) * 100)}%` }}
          />
        </div>
        <div className="text-[10px] text-gray-400 font-mono mt-1">
          CPU Clock: <span className="text-blue-400 font-bold">{cpuFrequency} MHz</span> | Est. Power: <span className="text-amber-400 font-bold">{
            cpuFrequency === 240 ? '180mA' : 
            cpuFrequency === 160 ? '120mA' : 
            cpuFrequency === 80 ? '35mA' : 
            cpuFrequency === 40 ? '15mA' : '4mA'
          }</span>
        </div>
      </div>
 
      {/* Simulator Toggles */}
      <section className="bg-gray-950/80 p-5 rounded-2xl border border-gray-800 space-y-4 shadow-xl">
        <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1.5"><Flame size={14} className="text-orange-500" /> Simulate Hardware Stress</h4>
        
        {/* Dynamic CPU Speed Selector */}
        <div className="space-y-2 pb-3 border-b border-gray-800">
          <label className="block text-xs font-bold text-gray-300">ESP32 CPU Clock Frequency</label>
          <div className="grid grid-cols-2 gap-2">
            <button 
              onClick={() => setCpuFrequency(240)}
              className={`py-2 px-3 rounded-lg text-xs font-mono font-bold border transition-all ${cpuFrequency === 240 ? 'bg-amber-500/10 border-amber-500 text-amber-400' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white'}`}
            >
              240 MHz (Default)
            </button>
            <button 
              onClick={() => setCpuFrequency(160)}
              className={`py-2 px-3 rounded-lg text-xs font-mono font-bold border transition-all ${cpuFrequency === 160 ? 'bg-blue-500/10 border-blue-500 text-blue-400' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white'}`}
            >
              160 MHz (Balanced)
            </button>
            <button 
              onClick={() => setCpuFrequency(80)}
              className={`py-2 px-3 rounded-lg text-xs font-mono font-bold border transition-all ${cpuFrequency === 80 ? 'bg-emerald-500/10 border-emerald-500 text-emerald-400' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white'}`}
            >
              80 MHz (Low Power)
            </button>
            <button 
              onClick={() => setCpuFrequency(40)}
              className={`py-2 px-3 rounded-lg text-xs font-mono font-bold border transition-all ${cpuFrequency === 40 ? 'bg-cyan-500/10 border-cyan-500 text-cyan-400' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white'}`}
            >
              40 MHz (Ultra Low)
            </button>
            <button 
              onClick={() => setCpuFrequency(10)}
              className={`py-2 px-3 rounded-lg text-xs font-mono font-bold border col-span-2 transition-all ${cpuFrequency === 10 ? 'bg-teal-500/10 border-teal-500 text-teal-400' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white'}`}
            >
              10 MHz (Deep Underclocked)
            </button>
          </div>
          <span className="block text-[9px] text-gray-500 leading-normal">
            By default, the ESP32 runs at 240MHz. Dropping to 80MHz, 40MHz, or 10MHz reduces switching power by up to 95%+ (Dynamic Power: P ∝ C·V²·f), keeping the processor ice-cold and maximizing runtime.
          </span>
        </div>

        <div className="flex items-start gap-3 pt-1">
          <input 
            type="checkbox"
            id="pin-conflict-toggle"
            checked={isPinConflict}
            onChange={(e) => setIsPinConflict(e.target.checked)}
            className="mt-1 h-4 w-4 cursor-pointer rounded border-gray-700 bg-gray-800 text-red-500 focus:ring-red-500/50"
          />
          <label htmlFor="pin-conflict-toggle" className="cursor-pointer select-none">
            <span className="block text-xs font-bold text-gray-200 hover:text-white transition-colors">1. Output-vs-Output Pin Conflict</span>
            <span className="block text-[10px] text-gray-400 leading-normal mt-0.5">
              Configures GPIO 13 on ESP32 as an <code>OUTPUT</code> driven <code>HIGH</code>. When the IR sensor detects an object and pulls its line <code>LOW</code>, a heavy short circuit direct loop runs between the silicon, heating up both units immediately!
            </span>
          </label>
        </div>

        <div className="flex items-start gap-3 border-t border-gray-800 pt-4">
          <input 
            type="checkbox"
            id="power-budget-toggle"
            checked={isPowerBudgetExceeded}
            onChange={(e) => setIsPowerBudgetExceeded(e.target.checked)}
            className="mt-1 h-4 w-4 cursor-pointer rounded border-gray-700 bg-gray-800 text-amber-500 focus:ring-amber-500/50"
          />
          <label htmlFor="power-budget-toggle" className="cursor-pointer select-none">
            <span className="block text-xs font-bold text-gray-200 hover:text-white transition-colors">2. Exceed Onboard Regulator Load</span>
            <span className="block text-[10px] text-gray-400 leading-normal mt-0.5">
              Simulates drawing high simultaneous current for active WiFi, 0.96" OLED display, active buzzer, and IR sensor through the small onboard 3.3V voltage regulator (causing slow heat buildup).
            </span>
          </label>
        </div>
      </section>

      {/* Hospital Solutions Guide */}
      <div className="space-y-4">
        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-1"><HelpCircle size={14} /> Hospital Deployment Fixes</h3>

        <section className="bg-emerald-950/20 border border-emerald-900/40 p-4 rounded-xl space-y-2">
          <h4 className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
            <Zap size={14} className="text-emerald-400" /> Fix 1: Underclock CPU to 80MHz ($P \propto f$)
          </h4>
          <p className="text-[10px] text-gray-300 leading-relaxed">
            For low-throughput IoT devices (like a clock/distance tracker), running at 240MHz is a waste of energy and generates high static & active thermal dissipation. Underclocking drops temperature immediately.
          </p>
          <div className="bg-black/60 p-2.5 rounded font-mono text-[10px] text-emerald-300 border border-gray-800">
            <span className="text-gray-500">// Drop clock from 240MHz to 80MHz in setup()</span><br />
            setCpuFrequencyMhz(80);
          </div>
          <p className="text-[9px] text-gray-400 italic leading-relaxed">
            <b>Changes that occur:</b> Dynamic power drops by 66%, the processor and voltage regulator stay near room temperature, extending their lifespan, and battery run-time is tripled. Refresh rate is unaffected as 80MHz is still 80 million cycles per second!
          </p>
        </section>

        <section className="bg-red-950/20 border border-red-900/40 p-4 rounded-xl space-y-2">
          <h4 className="text-xs font-bold text-red-400 flex items-center gap-1.5">
            <AlertTriangle size={14} /> Fix 2: Explicit C++ Code pinMode
          </h4>
          <p className="text-[10px] text-gray-300 leading-relaxed">
            In your physical Arduino sketch, make sure the pin connected to the IR sensor's output is declared as an <b>INPUT</b> in <code>setup()</code>:
          </p>
          <div className="bg-black/60 p-2.5 rounded font-mono text-[10px] text-emerald-300 border border-gray-800">
            <span className="text-gray-500">// Ensure IR_PIN reads state, never outputs!</span><br />
            pinMode(IR_PIN, <span className="text-yellow-400 font-bold">INPUT</span>);
          </div>
        </section>

        <section className="bg-blue-950/20 border border-blue-900/40 p-4 rounded-xl space-y-2">
          <h4 className="text-xs font-bold text-blue-400 flex items-center gap-1.5">
            <ShieldCheck size={14} /> Fix 3: Bypassing 3.3V Power Rail
          </h4>
          <p className="text-[10px] text-gray-300 leading-relaxed">
            The small onboard 3.3V regulator on cheap ESP32 boards has very poor thermal dissipation and cannot supply multiple sensors. 
          </p>
          <p className="text-[10px] text-blue-400 font-bold leading-normal">
            💡 Hardware Fix: Disconnect the IR sensor's VCC wire from the ESP32's 3.3V pin and wire it directly to the 5V (or VIN) pin on your shield instead!
          </p>
          <p className="text-[10px] text-gray-400 leading-relaxed">
            Since your IR module is 5V-tolerant, it will run cooler, draw direct power from USB, and save the ESP32's internal regulator from high load!
          </p>
        </section>
      </div>
    </div>
  );
};

let sharedAudioCtx: AudioContext | null = null;

const playWebBeep = (freq: number, durationMs: number) => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    if (!sharedAudioCtx) {
      sharedAudioCtx = new AudioContextClass();
    }
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
    const osc = sharedAudioCtx.createOscillator();
    const gain = sharedAudioCtx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, sharedAudioCtx.currentTime);
    
    gain.gain.setValueAtTime(0.05, sharedAudioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.0001, sharedAudioCtx.currentTime + durationMs / 1000);
    
    osc.connect(gain);
    gain.connect(sharedAudioCtx.destination);
    
    osc.start();
    osc.stop(sharedAudioCtx.currentTime + durationMs / 1000);
  } catch (e) {
    console.warn("Audio Context not allowed or supported by browser policy", e);
  }
};

const playWebStrikeFeedback = (type: 'Q' | 'S' | 'R', strikeCount: number) => {
  let freq = 1000;
  let dur = 100;

  if (type === 'Q') {
    freq = 2500;
    dur = 80;
  } else if (type === 'S') {
    freq = 1800;
    dur = 150;
  } else if (type === 'R') {
    freq = 1200;
    dur = 400;
  }

  // 1. Play the respective tone first
  playWebBeep(freq, dur);

  // 2. Play strike sound if strikeCount > 0
  if (strikeCount > 0) {
    const strikeBeeps = strikeCount + 2;
    const baseHigh = 2800 + (strikeCount * 50);
    const baseLow = 2100 + (strikeCount * 50);

    // Start strike sound after respective tone duration + 100ms
    setTimeout(() => {
      for (let i = 0; i < strikeBeeps; i++) {
        const beepDelay = i * 270; // 120ms sound + 150ms delay
        const currentFreq = (i % 2 === 0) ? baseHigh : baseLow;
        setTimeout(() => {
          playWebBeep(currentFreq, 120);
        }, beepDelay);
      }
    }, dur + 100);
  }
};

const playSatisfyingChime = (hours: number) => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    if (!sharedAudioCtx) {
      sharedAudioCtx = new AudioContextClass();
    }
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
    
    const numBeeps = hours + 2; // Hour 1 = 3 beeps, Hour 2 = 4 beeps, Hour 3 = 5 beeps, etc.
    const now = sharedAudioCtx.currentTime;
    
    for (let i = 0; i < numBeeps; i++) {
      const startTime = now + i * 0.3; // Beeps spaced 300ms apart
      
      const osc = sharedAudioCtx.createOscillator();
      const gain = sharedAudioCtx.createGain();
      
      osc.type = 'sine';
      const freq = (i % 2 === 0) ? 2400 : 1600; // Alternating high (2400Hz) and low (1600Hz) tones
      osc.frequency.setValueAtTime(freq, startTime);
      
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.05, startTime + 0.01);
      gain.gain.setValueAtTime(0.05, startTime + 0.14);
      gain.gain.linearRampToValueAtTime(0, startTime + 0.15); // 150ms beep duration
      
      osc.connect(gain);
      gain.connect(sharedAudioCtx.destination);
      
      osc.start(startTime);
      osc.stop(startTime + 0.15);
    }
  } catch (e) {
    console.warn("Satisfying chime Web Audio error:", e);
  }
};

export default function App() {
  const [state, setState] = useState<HardwareState>({
    questions: 0,
    irDetected: false,
    irProgress: 0,
    timerSeconds: 0,
    irDistance: 50,
    questionTimerSeconds: 0,
    lastQuestionTime: 0,
    sittingTime: 0,
    lastSittingTime: 0,
    isUploading: false,
    buttonHoldTime: 0,
    solutions: 0,
    revisions: 0,
    avgTimeResetVal: 0,
    avgQuestionsResetVal: 0,
    btn14HoldTime: 0,
    consecutiveStrikes: 0,
  });

  const [activeTab, setActiveTab] = useState<'sim' | 'code'>('sim');
  const [rightPanel, setRightPanel] = useState<'wiring' | 'backend' | 'thermal'>('thermal');
  const [isPinConflict, setIsPinConflict] = useState(false);
  const [isPowerBudgetExceeded, setIsPowerBudgetExceeded] = useState(false);
  const [cpuFrequency, setCpuFrequency] = useState(10);
  const [temperature, setTemperature] = useState(32);

  // New Break states (GPIO 34)
  const [breakType, setBreakType] = useState<'SB' | 'LB' | null>(null);
  const [breakSecondsRemaining, setBreakSecondsRemaining] = useState<number>(0);
  const [gpio34HoldTime, setGpio34HoldTime] = useState<number>(0);
  const [isGpio34Pressed, setIsGpio34Pressed] = useState<boolean>(false);

  // Theory Mode states (GPIO 32 double press)
  const [isTheoryMode, setIsTheoryMode] = useState<boolean>(false);
  const [theorySecondsRemaining, setTheorySecondsRemaining] = useState<number>(0);
  const [lastBreakRelease, setLastBreakRelease] = useState<number>(0);

  const [alarmActiveSeconds, setAlarmActiveSeconds] = useState<number>(0);

  // Hourly chime sound test state
  const [chimeTestHour, setChimeTestHour] = useState<number>(1);

  // RGB LED State (GPIO 25 = Red, GPIO 26 = Green, GPIO 27 = Blue)
  const [rgbColor, setRgbColor] = useState<{ r: boolean; g: boolean; b: boolean }>({ r: false, g: false, b: false });
  const [flashColor, setFlashColor] = useState<'blue' | 'green' | 'purple' | null>(null);

  const triggerStrikeBlinks = (color: 'blue' | 'green' | 'purple', count: number) => {
    let r = false, g = false, b = false;
    let dur = 100;
    let interval = 250; // default spacing for 2 blinks

    if (color === 'blue') {
      b = true;
      dur = 80;
    } else if (color === 'green') {
      g = true;
      dur = 150;
    } else if (color === 'purple') {
      r = true; b = true;
      dur = 400;
    }

    if (count >= 3) {
      interval = 1000; // 1-second interval for 3 or more strikes!
    }

    const totalBlinks = count > 0 ? count : 1;
    
    // Play multiple blinks sequentially using timeouts
    for (let i = 0; i < totalBlinks; i++) {
      const delayTime = i * (dur + interval);
      setTimeout(() => {
        setRgbColor({ r, g, b });
        setFlashColor(color);

        setTimeout(() => {
          setRgbColor({ r: false, g: false, b: false });
          setFlashColor(null);
        }, dur);
      }, delayTime);
    }
  };

  // Temperature Simulation Loop
  useEffect(() => {
    const interval = setInterval(() => {
      setTemperature(prev => {
        let targetTemp = 32;
        if (cpuFrequency === 160) targetTemp = 29;
        else if (cpuFrequency === 80) targetTemp = 25;
        else if (cpuFrequency === 40) targetTemp = 22;
        else if (cpuFrequency === 10) targetTemp = 19;

        if (isPinConflict && state.irDetected) {
          // Rapid intense short-circuit heating when active
          targetTemp = 88;
        } else if (isPinConflict) {
          // Moderately hot on standby pin clash
          targetTemp = 58;
        } else if (isPowerBudgetExceeded) {
          // Slow regulator thermal load, cooler if underclocked
          if (cpuFrequency === 240) targetTemp = 64;
          else if (cpuFrequency === 160) targetTemp = 51;
          else if (cpuFrequency === 80) targetTemp = 36;
          else if (cpuFrequency === 40) targetTemp = 28;
          else targetTemp = 22; // 10MHz
        }
        
        if (prev < targetTemp) {
          return Math.min(prev + 4, targetTemp);
        } else if (prev > targetTemp) {
          return Math.max(prev - 2, targetTemp);
        }
        return prev;
      });
    }, 500);
    return () => clearInterval(interval);
  }, [isPinConflict, isPowerBudgetExceeded, cpuFrequency, state.irDetected]);

  // Short-circuit warning tone loop
  useEffect(() => {
    let interval: number;
    if (isPinConflict && state.irDetected) {
      interval = window.setInterval(() => {
        // High distress alarm beeps to warn of short circuit
        playWebBeep(3200, 50);
        setTimeout(() => playWebBeep(3200, 50), 120);
      }, 1500);
    }
    return () => clearInterval(interval);
  }, [isPinConflict, state.irDetected]);

  // Auto-resume audio context on first interaction
  useEffect(() => {
    const unlockAudio = () => {
      if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
        sharedAudioCtx.resume().catch(() => {});
      }
    };
    window.addEventListener('click', unlockAudio);
    window.addEventListener('touchstart', unlockAudio);
    return () => {
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
  }, []);

  // Button Hold Logic
  useEffect(() => {
    let interval: number;
    if (state.buttonHoldTime > 0 && !state.isUploading) {
      interval = window.setInterval(() => {
        setState(prev => {
          const newTime = prev.buttonHoldTime + 100;
          if (newTime >= 5000) {
            // Trigger Upload
            return { ...prev, isUploading: true, buttonHoldTime: 0 };
          }
          return { ...prev, buttonHoldTime: newTime };
        });
      }, 100);
    }
    return () => clearInterval(interval);
  }, [state.buttonHoldTime, state.isUploading]);

  // Button 2 (GPIO 14) Hold Logic
  useEffect(() => {
    let interval: number;
    if (state.btn14HoldTime > 0) {
      interval = window.setInterval(() => {
        setState(prev => ({
          ...prev,
          btn14HoldTime: prev.btn14HoldTime + 100,
        }));
      }, 100);
    }
    return () => clearInterval(interval);
  }, [state.btn14HoldTime]);

  // Upload Simulation
  useEffect(() => {
    if (state.isUploading) {
      playWebBeep(3000, 150);
      const timer = setTimeout(() => {
        setState(prev => ({
          ...prev,
          isUploading: false,
          questions: 0,
          timerSeconds: 0,
          questionTimerSeconds: 0,
          solutions: 0,
          revisions: 0,
          avgTimeResetVal: 0,
          avgQuestionsResetVal: 0,
        }));
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [state.isUploading]);

  // GPIO 34 Break Button Hold Logic
  useEffect(() => {
    let interval: number;
    if (isGpio34Pressed) {
      interval = window.setInterval(() => {
        setGpio34HoldTime(prev => prev + 100);
      }, 100);
    }
    return () => clearInterval(interval);
  }, [isGpio34Pressed]);

  // Master independent timer countdown loop for break and theory timers
  useEffect(() => {
    const interval = setInterval(() => {
      // Decrement break remaining
      setBreakSecondsRemaining(prev => {
        if (prev > 1) {
          return prev - 1;
        } else if (prev === 1) {
          // Break is over
          setBreakType(null);
          // Beep signaling break has expired
          playWebBeep(1200, 300);
          setTimeout(() => playWebBeep(1000, 300), 320);
          return 0;
        }
        return 0;
      });

      // Decrement theory remaining
      setTheorySecondsRemaining(prev => {
        if (prev > 1) {
          return prev - 1;
        } else if (prev === 1) {
          // Theory time is over!
          setIsTheoryMode(false);
          // Happy finish study beeps
          playWebBeep(2000, 150);
          setTimeout(() => playWebBeep(2400, 200), 200);
          return 0;
        }
        return 0;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Track consecutive seconds the alarm has been active
  useEffect(() => {
    let intervalId: number;
    const isAlarmTriggered = !state.irDetected && !state.isUploading && breakSecondsRemaining <= 0;
    
    if (isAlarmTriggered) {
      intervalId = window.setInterval(() => {
        setAlarmActiveSeconds(prev => prev + 1);
      }, 1000);
    } else {
      setAlarmActiveSeconds(0);
    }
    
    return () => clearInterval(intervalId);
  }, [state.irDetected, state.isUploading, breakSecondsRemaining]);

  // Annoying Passive Buzzer Alarm Sound & Blinking Red RGB LED Loop
  useEffect(() => {
    let interval: number;
    let alarmToggle = false;
    
    // Annoy only if user stands up without break, or break has expired, and not uploading
    const isAlarmTriggered = !state.irDetected && !state.isUploading && breakSecondsRemaining <= 0;
    
    if (isAlarmTriggered) {
      const isUrgent = alarmActiveSeconds >= 900; // 15 minutes
      const beepInterval = isUrgent ? 125 : 250; // Beep faster (8Hz vs 4Hz) if absent for > 15 minutes (900s) to increase irritation
      
      interval = window.setInterval(() => {
        alarmToggle = !alarmToggle;
        
        // Blink RED LED pin state in sync with irritating sound
        setRgbColor({ r: alarmToggle, g: false, b: false });
        
        if (alarmToggle) {
          const freq = 2600;
          const dur = isUrgent ? 90 : 180;
          playWebBeep(freq, dur);
        } else {
          const freq = 2200;
          const dur = isUrgent ? 90 : 180;
          playWebBeep(freq, dur);
        }
      }, beepInterval);
    } else {
      // Clean up red light if alarm condition clears, keeping it if quiet blink is active
      setRgbColor(prev => {
        const keepRedIfBlinking = state.irDetected && state.questionTimerSeconds >= 420 && (state.questionTimerSeconds % 3 === 0);
        return { ...prev, r: keepRedIfBlinking ? prev.r : false };
      });
    }
    
    return () => clearInterval(interval);
  }, [state.irDetected, state.isUploading, breakSecondsRemaining, state.questionTimerSeconds, alarmActiveSeconds]);

  // Quiet Red blink/sound for inactive sitting periods
  // Starts at 7 minutes (420s) as quiet blinking, after 10 minutes (600s) adds a soft irritating sound
  useEffect(() => {
    if (state.irDetected) {
      if (isTheoryMode) {
        // Bypassed during Theory Mode. Ensure LED is cleared.
        setRgbColor(prev => ({
          ...prev,
          r: false,
          g: false,
          b: false
        }));
        return;
      }

      if (state.questionTimerSeconds === 180) {
        // 3-Minute Awareness Alert: 2 pink/purple flashes & 2 beep sounds
        const beepFreq = 2000;
        const beepDur = 150;
        const spacing = 300;

        // Beep 1 & Flash 1
        playWebBeep(beepFreq, beepDur);
        setRgbColor({ r: true, g: false, b: true });
        setTimeout(() => {
          setRgbColor({ r: false, g: false, b: false });
        }, beepDur);

        // Beep 2 & Flash 2
        setTimeout(() => {
          playWebBeep(beepFreq, beepDur);
          setRgbColor({ r: true, g: false, b: true });
          setTimeout(() => {
            setRgbColor({ r: false, g: false, b: false });
          }, beepDur);
        }, spacing);
      } else if (state.questionTimerSeconds > 600) {
        // After 10 minutes: red blink + softer irritating sound every 3 seconds
        const shouldBlinkRed = state.questionTimerSeconds % 3 === 0;
        setRgbColor(prev => ({
          ...prev,
          r: shouldBlinkRed,
          g: false,
          b: false
        }));
        if (shouldBlinkRed) {
          playWebBeep(1500, 150); // Softer irritating tone
        }
      } else if (state.questionTimerSeconds >= 420) {
        // Starts at 7 minutes up to 10 minutes: only quiet blinking red
        const shouldBlinkRed = state.questionTimerSeconds % 3 === 0;
        setRgbColor(prev => ({
          ...prev,
          r: shouldBlinkRed,
          g: false,
          b: false
        }));
      } else {
        // Under 7 minutes: red light is off
        setRgbColor(prev => ({
          ...prev,
          r: false,
          g: false,
          b: false
        }));
      }
    }
  }, [state.irDetected, state.questionTimerSeconds, isTheoryMode]);

  // IR Progress & Timer logic
  useEffect(() => {
    let interval: number;
    if (state.irDetected && !state.isUploading) {
      interval = window.setInterval(() => {
        setState(prev => {
          const nextSeconds = prev.timerSeconds + 1;
          // Satisfying Hourly Chime
          if (nextSeconds > 0 && nextSeconds % 3600 === 0) {
            const currentHour = Math.max(1, Math.floor(nextSeconds / 3600));
            playSatisfyingChime(currentHour);
          }
          return {
            ...prev,
            timerSeconds: nextSeconds,
            questionTimerSeconds: prev.questionTimerSeconds + 1,
            sittingTime: prev.sittingTime + 1,
          };
        });
      }, 1000);
    } else if (!state.irDetected && state.sittingTime > 0) {
       // Just stood up
       setState(prev => ({
         ...prev,
         lastSittingTime: prev.sittingTime,
         sittingTime: 0
       }));
    }
    return () => clearInterval(interval);
  }, [state.irDetected, state.isUploading, state.sittingTime]);

  // Auto-cancel break when sitting is detected (IR active)
  useEffect(() => {
    if (state.irDetected && breakType !== null) {
      setBreakType(null);
      setBreakSecondsRemaining(0);
      playWebBeep(2000, 100);
      setTimeout(() => playWebBeep(1800, 100), 120);
    }
  }, [state.irDetected, breakType]);

  // Cancel Theory Mode when user stands up (IR detected goes false)
  useEffect(() => {
    if (!state.irDetected && isTheoryMode) {
      setIsTheoryMode(false);
      setTheorySecondsRemaining(0);
      playWebBeep(1000, 150);
      setTimeout(() => playWebBeep(800, 150), 170);
    }
  }, [state.irDetected, isTheoryMode]);

  const handleButtonDown = () => {
    setState(prev => ({ ...prev, buttonHoldTime: 100 }));
  };

  const handleButtonUp = () => {
    if (state.buttonHoldTime > 0 && state.buttonHoldTime < 5000) {
      // Short Press
      const isStrike = state.questionTimerSeconds <= 240;
      let newStrikes = 0;
      setState(prev => {
        if (isStrike) {
          newStrikes = prev.consecutiveStrikes + 1;
        } else {
          newStrikes = 0;
        }

        setTimeout(() => {
          playWebStrikeFeedback('Q', newStrikes);
          triggerStrikeBlinks('blue', newStrikes);
        }, 10);

        return {
          ...prev,
          questions: Math.min(prev.questions + 1, TARGET_QUESTIONS),
          lastQuestionTime: prev.questionTimerSeconds,
          questionTimerSeconds: 0,
          buttonHoldTime: 0,
          consecutiveStrikes: newStrikes
        };
      });
    } else {
      setState(prev => ({ ...prev, buttonHoldTime: 0 }));
    }
  };

  const handleButton2Down = () => {
    setState(prev => ({ ...prev, btn14HoldTime: 100 }));
  };

  const handleButton2Up = () => {
    if (state.btn14HoldTime > 0) {
      const held = state.btn14HoldTime;
      if (held < 2000) {
        // Solution Click (+1 S) - Green flash
        const isStrike = state.questionTimerSeconds <= 240;
        let newStrikes = 0;
        setState(prev => {
          if (isStrike) {
            newStrikes = prev.consecutiveStrikes + 1;
          } else {
            newStrikes = 0;
          }

          setTimeout(() => {
            playWebStrikeFeedback('S', newStrikes);
            triggerStrikeBlinks('green', newStrikes);
          }, 10);

          return {
            ...prev,
            solutions: prev.solutions + 1,
            lastQuestionTime: prev.questionTimerSeconds,
            questionTimerSeconds: 0,
            btn14HoldTime: 0,
            consecutiveStrikes: newStrikes
          };
        });
      } else if (held >= 2000 && held < 4000) {
        // Revision Hold (+1 R) - Purple flash
        const isStrike = state.questionTimerSeconds <= 240;
        let newStrikes = 0;
        setState(prev => {
          if (isStrike) {
            newStrikes = prev.consecutiveStrikes + 1;
          } else {
            newStrikes = 0;
          }

          setTimeout(() => {
            playWebStrikeFeedback('R', newStrikes);
            triggerStrikeBlinks('purple', newStrikes);
          }, 10);

          return {
            ...prev,
            revisions: prev.revisions + 1,
            lastQuestionTime: prev.questionTimerSeconds,
            questionTimerSeconds: 0,
            btn14HoldTime: 0,
            consecutiveStrikes: newStrikes
          };
        });
      } else {
        // Reset average hold (4s+) - Double chirp
        playWebBeep(3000, 100);
        setTimeout(() => playWebBeep(3500, 200), 120);
        setState(prev => ({
          ...prev,
          avgTimeResetVal: prev.timerSeconds,
          avgQuestionsResetVal: prev.questions + prev.solutions,
          lastQuestionTime: prev.questionTimerSeconds,
          questionTimerSeconds: 0,
          btn14HoldTime: 0
        }));
      }
    } else {
      setState(prev => ({ ...prev, btn14HoldTime: 0 }));
    }
  };

  const handleGpio34Down = () => {
    setIsGpio34Pressed(true);
    setGpio34HoldTime(100);
  };

  const handleGpio34Up = () => {
    if (isGpio34Pressed) {
      const held = gpio34HoldTime;
      setIsGpio34Pressed(false);
      setGpio34HoldTime(0);
      
      if (held < 1500) {
        // Simple click - check for double click (within 500ms)
        const now = Date.now();
        if (now - lastBreakRelease < 500) {
          // Double click detected! Start Theory Mode
          setIsTheoryMode(true);
          setTheorySecondsRemaining(20 * 60); // 20 minutes
          setBreakType(null); // Cancel any active break
          setBreakSecondsRemaining(0);
          
          // Play 3 rapid happy beeps
          playWebBeep(1800, 100);
          setTimeout(() => playWebBeep(2200, 100), 120);
          setTimeout(() => playWebBeep(2600, 150), 240);
        } else {
          playWebBeep(800, 50); // soft low tone indicating ignored click
        }
        setLastBreakRelease(now);
      } else if (held >= 1500 && held < 3000) {
        // Short Break SB: 5 minutes (300 seconds)
        setIsTheoryMode(false);
        setTheorySecondsRemaining(0);
        setBreakType('SB');
        setBreakSecondsRemaining(5 * 60);
        playWebBeep(1500, 120);
        setTimeout(() => playWebBeep(2000, 150), 140);
      } else if (held >= 3000 && held < 4500) {
        // Long Break LB: 20 minutes (1200 seconds)
        setIsTheoryMode(false);
        setTheorySecondsRemaining(0);
        setBreakType('LB');
        setBreakSecondsRemaining(20 * 60);
        playWebBeep(1000, 150);
        setTimeout(() => playWebBeep(1400, 150), 160);
        setTimeout(() => playWebBeep(1800, 200), 320);
      } else {
        // Two-Hour Break: 2 hours (120 minutes / 7200 seconds)
        setIsTheoryMode(false);
        setTheorySecondsRemaining(0);
        setBreakType('2H');
        setBreakSecondsRemaining(120 * 60);
        playWebBeep(1000, 120);
        setTimeout(() => playWebBeep(1200, 120), 140);
        setTimeout(() => playWebBeep(1500, 150), 280);
        setTimeout(() => playWebBeep(1800, 150), 420);
        setTimeout(() => playWebBeep(2200, 200), 560);
      }
    }
  };

  const reset = () => {
    playWebBeep(1000, 100);
    setIsTheoryMode(false);
    setTheorySecondsRemaining(0);
    setState({
      questions: 0,
      irDetected: false,
      irProgress: 0,
      timerSeconds: 0,
      irDistance: 50,
      questionTimerSeconds: 0,
      lastQuestionTime: 0,
      sittingTime: 0,
      lastSittingTime: 0,
      isUploading: false,
      buttonHoldTime: 0,
      solutions: 0,
      revisions: 0,
      avgTimeResetVal: 0,
      avgQuestionsResetVal: 0,
      btn14HoldTime: 0,
      consecutiveStrikes: 0,
    });
  };

  const simulatePowerCut = () => {
    playWebBeep(600, 300);
    setIsTheoryMode(false);
    setTheorySecondsRemaining(0);
    setState(prev => ({
      ...prev,
      consecutiveStrikes: 0, // K is always reset when switching off and on
      irDetected: false,
      irDistance: 50,
      questionTimerSeconds: 0,
      btn14HoldTime: 0,
      buttonHoldTime: 0,
    }));
    alert("Power Cut Simulated! Data from NVS loaded, but K (consecutive strikes) has been reset to 0.");
  };

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-gray-100 p-4 md:p-8 font-sans selection:bg-blue-500/30">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <header className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <motion.h1 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-4xl md:text-5xl font-bold tracking-tighter bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent"
            >
              navQtracker
            </motion.h1>
            <p className="text-gray-400 mt-2 max-w-md">
              Hardware simulation of an ESP32 expansion shield setup with OLED, Button, and IR Sensor.
            </p>
          </div>
          
          <div className="flex bg-gray-900 p-1 rounded-lg border border-gray-800">
            <button 
              onClick={() => setActiveTab('sim')}
              className={`px-4 py-2 rounded-md flex items-center gap-2 transition-all ${activeTab === 'sim' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-gray-200'}`}
            >
              <Layout size={18} /> Simulation
            </button>
            <button 
              onClick={() => setActiveTab('code')}
              className={`px-4 py-2 rounded-md flex items-center gap-2 transition-all ${activeTab === 'code' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-gray-200'}`}
            >
              <Code size={18} /> Code
            </button>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Simulation / Code */}
          <div className="lg:col-span-8 space-y-8">
            <AnimatePresence mode="wait">
              {activeTab === 'sim' ? (
                <motion.div 
                  key="sim"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="space-y-8"
                >
                  {/* OLED Display Area */}
                  <div className="bg-gray-900/50 rounded-3xl p-8 border border-gray-800 flex flex-col items-center justify-center relative group">
                    <div className="absolute top-4 left-4 text-[10px] text-gray-600 uppercase tracking-widest font-mono">Simulated SSD1306 OLED</div>
                    <SimulatedOLED 
                      state={state} 
                      temperature={temperature} 
                      isPinConflict={isPinConflict} 
                      breakType={breakType}
                      breakSecondsRemaining={breakSecondsRemaining}
                      gpio34HoldTime={gpio34HoldTime}
                      isGpio34Pressed={isGpio34Pressed}
                      alarmActiveSeconds={alarmActiveSeconds}
                      isTheoryMode={isTheoryMode}
                      theorySecondsRemaining={theorySecondsRemaining}
                    />
                    
                    {/* RGB LED Module representation */}
                    <div className="mt-8 w-full max-w-sm flex flex-col items-center gap-3 bg-black/40 px-6 py-4 rounded-2xl border border-gray-800/80">
                      <div className="text-[10px] text-gray-400 font-mono uppercase tracking-widest text-center">Onboard RGB Module</div>
                      <div className="flex items-center justify-between w-full gap-4">
                        {/* Glow indicator bulb */}
                        <div className="relative flex items-center justify-center w-12 h-12">
                          {/* Inner bulb */}
                          <div 
                            className="w-8 h-8 rounded-full border-2 border-gray-600 transition-all duration-300 relative z-10"
                            style={{
                              backgroundColor: rgbColor.r && rgbColor.b ? '#a855f7' : rgbColor.r ? '#ef4444' : rgbColor.g ? '#22c55e' : rgbColor.b ? '#3b82f6' : '#1f2937',
                              boxShadow: (rgbColor.r || rgbColor.g || rgbColor.b) ? `0 0 25px 8px ${
                                rgbColor.r && rgbColor.b ? 'rgba(168,85,247,0.8)' : rgbColor.r ? 'rgba(239,68,68,0.8)' : rgbColor.g ? 'rgba(34,197,94,0.8)' : 'rgba(59,130,246,0.8)'
                              }` : 'none'
                            }}
                          >
                            <div className="absolute top-1 left-1.5 w-2 h-1 bg-white/40 rounded-full rotate-12" />
                          </div>
                          {/* Outer halo */}
                          {(rgbColor.r || rgbColor.g || rgbColor.b) && (
                            <span className="absolute animate-ping inline-flex h-10 w-10 rounded-full bg-current opacity-20"
                              style={{
                                color: rgbColor.r && rgbColor.b ? '#a855f7' : rgbColor.r ? '#ef4444' : rgbColor.g ? '#22c55e' : '#3b82f6'
                              }}
                            />
                          )}
                        </div>
                        {/* Pin status indicators */}
                        <div className="text-[10px] font-mono space-y-1 text-gray-400 flex-1 pl-4 border-l border-gray-800">
                          <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${rgbColor.r ? 'bg-red-500 shadow-[0_0_5px_#ef4444]' : 'bg-gray-800'}`} />
                            <span>RED (GPIO 25): <span className={rgbColor.r ? 'text-red-400 font-bold' : ''}>{rgbColor.r ? 'HIGH' : 'LOW'}</span></span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${rgbColor.g ? 'bg-emerald-500 shadow-[0_0_5px_#22c55e]' : 'bg-gray-800'}`} />
                            <span>GRN (GPIO 26): <span className={rgbColor.g ? 'text-emerald-400 font-bold' : ''}>{rgbColor.g ? 'HIGH' : 'LOW'}</span></span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${rgbColor.b ? 'bg-blue-500 shadow-[0_0_5px_#3b82f6]' : 'bg-gray-800'}`} />
                            <span>BLU (GPIO 27): <span className={rgbColor.b ? 'text-blue-400 font-bold' : ''}>{rgbColor.b ? 'HIGH' : 'LOW'}</span></span>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {/* Wiring Info Overlay */}
                    <div className="mt-6 grid grid-cols-2 gap-4 text-[10px] font-mono text-gray-500">
                      <div className="flex items-center gap-1"><Zap size={10} className="text-yellow-500" /> SCL: GPIO 22</div>
                      <div className="flex items-center gap-1"><Zap size={10} className="text-yellow-500" /> SDA: GPIO 21</div>
                    </div>
                  </div>

                  {/* Hardware Controls */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                    <div className="bg-gray-900/40 p-4 rounded-xl border border-gray-800 hover:border-blue-500/50 transition-colors flex flex-col justify-between">
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="font-semibold flex items-center gap-1 text-xs"><MousePointer2 size={14} className="text-blue-400" /> Push Button</h3>
                          <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded">GPIO 4</span>
                        </div>
                        <p className="text-[11px] text-gray-400 mb-4 leading-relaxed">Short Press: Next Q<br />Long Press (5s): Upload & Reset</p>
                      </div>
                      <button 
                        onMouseDown={handleButtonDown}
                        onMouseUp={handleButtonUp}
                        onMouseLeave={handleButtonUp}
                        className={`w-full py-2.5 transition-all rounded-lg font-bold text-xs shadow-lg flex items-center justify-center gap-1.5 ${state.buttonHoldTime >= 5000 ? 'bg-red-600' : 'bg-blue-600 hover:bg-blue-500 active:scale-95'}`}
                      >
                        <Play size={14} /> {state.buttonHoldTime > 0 ? `Holding...` : 'Press Button'}
                      </button>
                    </div>

                    <div className="bg-gray-900/40 p-4 rounded-xl border border-gray-800 hover:border-violet-500/50 transition-colors flex flex-col justify-between">
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="font-semibold flex items-center gap-1 text-xs"><MousePointer2 size={14} className="text-violet-400" /> Action Button</h3>
                          <span className="text-[9px] bg-violet-500/20 text-violet-400 px-1.5 py-0.5 rounded">GPIO 14</span>
                        </div>
                        <p className="text-[11px] text-gray-400 mb-4 leading-relaxed">Short: +1 Sol (S) [Green Flash]<br />Hold 2s: +1 Rev (R) [Purple Flash] | 4s: Reset Avg</p>
                      </div>
                      <button 
                        onMouseDown={handleButton2Down}
                        onMouseUp={handleButton2Up}
                        onMouseLeave={handleButton2Up}
                        className={`w-full py-2.5 transition-all rounded-lg font-bold text-xs shadow-lg flex items-center justify-center gap-1.5 ${state.btn14HoldTime >= 4000 ? 'bg-red-600' : state.btn14HoldTime >= 2000 ? 'bg-amber-600' : 'bg-violet-600 hover:bg-violet-500 active:scale-95'}`}
                      >
                        <Play size={14} /> {state.btn14HoldTime > 0 ? `Holding...` : 'Press Button 2'}
                      </button>
                    </div>

                    {/* New Break Button on GPIO 32 / 34 */}
                    <div className="bg-gray-900/40 p-4 rounded-xl border border-gray-800 hover:border-amber-500/50 transition-colors flex flex-col justify-between">
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="font-semibold flex items-center gap-1 text-xs"><MousePointer2 size={14} className="text-amber-400" /> Break Button</h3>
                          <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded">GPIO 32</span>
                        </div>
                        <p className="text-[11px] text-gray-400 mb-4 leading-relaxed">
                          Hold 1.5s: 5m Short Break (SB)<br />
                          Hold 3s: 20m Long Break (LB)<br />
                          Hold 4.5s: 2h Break (2H)<br />
                          <span className="text-red-400 font-medium">Click / short press is ignored to prevent mistakes.</span>
                        </p>
                      </div>
                      <button 
                        onMouseDown={handleGpio34Down}
                        onMouseUp={handleGpio34Up}
                        onMouseLeave={handleGpio34Up}
                        className={`w-full py-2.5 transition-all rounded-lg font-bold text-xs shadow-lg flex items-center justify-center gap-1.5 ${isGpio34Pressed ? 'bg-amber-700 animate-pulse' : 'bg-amber-600 hover:bg-amber-500 active:scale-95'}`}
                      >
                        <Play size={14} /> {isGpio34Pressed ? `Holding (${(gpio34HoldTime / 1000).toFixed(1)}s)` : 'Press Break'}
                      </button>
                    </div>

                    <div className="bg-gray-900/40 p-4 rounded-xl border border-gray-800 hover:border-emerald-500/50 transition-colors flex flex-col justify-between">
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="font-semibold flex items-center gap-1 text-xs"><Cpu size={14} className="text-emerald-400" /> IR Sensor</h3>
                          <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded">GPIO 13</span>
                        </div>
                        <p className="text-[11px] text-gray-400 mb-2 leading-relaxed">Adjust distance range to simulate sitting/standing.</p>
                      </div>
                      
                      <div className="space-y-3">
                        <div className="flex items-center justify-between text-[10px] text-gray-500 font-mono">
                          <span>Dist: {state.irDistance}cm</span>
                          <span className={state.irDetected ? 'text-emerald-400 font-bold animate-pulse' : 'text-red-400 font-bold'}>
                            {state.irDetected ? 'SITTING' : 'STANDING'}
                          </span>
                        </div>
                        <input 
                          type="range" 
                          min="0" 
                          max="80" 
                          value={state.irDistance}
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            setState(prev => ({ 
                             ...prev, 
                             irDistance: val,
                             irDetected: val <= 20 
                            }));
                          }}
                          className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                        />
                        <div className="flex justify-between text-[8px] text-gray-600 font-mono">
                          <span>0cm</span>
                          <span>20cm (Threshold)</span>
                          <span>80cm</span>
                        </div>

                        {/* Quick-test >3m, >7m, and >10m inactivity triggers */}
                        <div className="pt-2 border-t border-gray-800/60 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[9px] text-gray-400 font-mono">Test 3m Alert:</span>
                            <button
                              onClick={() => {
                                setState(prev => ({
                                  ...prev,
                                  questionTimerSeconds: prev.questionTimerSeconds === 178 ? 0 : 178,
                                  irDistance: 10,
                                  irDetected: true
                                }));
                              }}
                              className={`px-2 py-0.5 rounded text-[9px] font-bold font-mono transition-colors ${state.questionTimerSeconds >= 175 && state.questionTimerSeconds <= 182 ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                            >
                              {state.questionTimerSeconds >= 175 && state.questionTimerSeconds <= 182 ? 'Reset' : 'Set 178s'}
                            </button>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[9px] text-gray-400 font-mono">Test 7m+ Blink:</span>
                            <button
                              onClick={() => {
                                setState(prev => ({
                                  ...prev,
                                  questionTimerSeconds: prev.questionTimerSeconds === 425 ? 0 : 425,
                                  irDistance: 10,
                                  irDetected: true
                                }));
                              }}
                              className={`px-2 py-0.5 rounded text-[9px] font-bold font-mono transition-colors ${state.questionTimerSeconds >= 420 && state.questionTimerSeconds < 600 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                            >
                              {state.questionTimerSeconds >= 420 && state.questionTimerSeconds < 600 ? 'Reset' : 'Set 7m+'}
                            </button>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[9px] text-gray-400 font-mono">Test 10m+ Alert:</span>
                            <button
                              onClick={() => {
                                setState(prev => ({
                                  ...prev,
                                  questionTimerSeconds: prev.questionTimerSeconds > 600 ? 0 : 601,
                                  irDistance: 10,
                                  irDetected: true
                                }));
                              }}
                              className={`px-2 py-0.5 rounded text-[9px] font-bold font-mono transition-colors ${state.questionTimerSeconds > 600 ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                            >
                              {state.questionTimerSeconds > 600 ? 'Reset' : 'Set 10m+'}
                            </button>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[9px] text-gray-400 font-mono">Test 15m+ Stand-up:</span>
                            <button
                              onClick={() => {
                                setAlarmActiveSeconds(prev => prev >= 900 ? 0 : 905);
                                setBreakSecondsRemaining(0);
                                setState(prev => ({
                                  ...prev,
                                  irDistance: 40, // Trigger standing (distance > 20)
                                  irDetected: false
                                }));
                              }}
                              className={`px-2 py-0.5 rounded text-[9px] font-bold font-mono transition-colors ${alarmActiveSeconds >= 900 ? 'bg-red-600/30 text-red-400 border border-red-500/40 animate-pulse' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                            >
                              {alarmActiveSeconds >= 900 ? 'Reset' : 'Set 15m+'}
                            </button>
                          </div>
                        </div>

                        {/* Quick-test <4m Strike trigger */}
                        <div className="pt-2 border-t border-gray-800/60 flex items-center justify-between gap-2">
                          <span className="text-[9px] text-gray-400 font-mono">Test &lt;4m Strike:</span>
                          <button
                            onClick={() => {
                              setState(prev => ({
                                ...prev,
                                questionTimerSeconds: 10, // 10s is well under 4 minutes
                              }));
                            }}
                            className="px-2 py-0.5 rounded text-[9px] font-bold font-mono transition-colors bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30"
                          >
                            Set &lt;4m
                          </button>
                        </div>

                        {/* Quick-test Theory Mode trigger */}
                        <div className="pt-2 border-t border-gray-800/60 flex items-center justify-between gap-2">
                          <span className="text-[9px] text-gray-400 font-mono">Test Theory Mode:</span>
                          <button
                            onClick={() => {
                              setIsTheoryMode(prev => !prev);
                              setTheorySecondsRemaining(prev => prev > 0 ? 0 : 20 * 60);
                              setBreakType(null);
                              setBreakSecondsRemaining(0);
                              if (!isTheoryMode) {
                                playWebBeep(1800, 100);
                                setTimeout(() => playWebBeep(2200, 100), 120);
                                setTimeout(() => playWebBeep(2600, 150), 240);
                              }
                            }}
                            className={`px-2 py-0.5 rounded text-[9px] font-bold font-mono transition-colors ${isTheoryMode ? 'bg-purple-600 text-white animate-pulse' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                          >
                            {isTheoryMode ? 'Active (Disable)' : 'Enable Theory'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Hourly Study Completion Chime Tester */}
                  <div className="bg-gray-900/40 p-6 rounded-2xl border border-gray-800 hover:border-amber-500/30 transition-colors space-y-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="p-2 bg-amber-500/10 text-amber-400 rounded-lg">
                          <Volume2 size={18} className="animate-pulse" />
                        </div>
                        <div>
                          <h3 className="font-bold text-sm text-gray-200">Milestone Chime Audio Lab</h3>
                          <p className="text-[10px] text-amber-400/80 font-mono font-medium">Research-Backed Dopamine Optimization</p>
                        </div>
                      </div>
                      <span className="text-[9px] bg-gray-800/80 text-gray-400 px-2 py-0.5 rounded font-mono">GPIO 18 Simulator</span>
                    </div>

                    <p className="text-xs text-gray-400 leading-relaxed">
                      To help maintain momentum, completing each hour of study plays a satisfying milestone tone using alternating high and low tones of the passive buzzer (<strong className="text-amber-400">2400 Hz and 1600 Hz</strong>). It starts with <strong className="text-amber-400">3 alternating beeps</strong> for the 1st hour and adds <strong className="text-white">+1 beep</strong> for each subsequent hour (e.g. 4 beeps for Hour 2, 5 beeps for Hour 3, etc.).
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2 items-center">
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs font-mono text-gray-400">
                          <span>Set Test Hour:</span>
                          <span className="text-amber-400 font-bold bg-amber-400/10 px-2 py-0.5 rounded">Hour {chimeTestHour}</span>
                        </div>
                        <input 
                          type="range" 
                          min="1" 
                          max="8" 
                          value={chimeTestHour}
                          onChange={(e) => setChimeTestHour(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
                        />
                        <div className="flex justify-between text-[9px] text-gray-500 font-mono">
                          <span>Hr 1 (3 Beeps)</span>
                          <span>Hr 8 (10 Beeps)</span>
                        </div>
                      </div>

                      <button
                        onClick={() => playSatisfyingChime(chimeTestHour)}
                        className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs rounded-xl transition-all shadow-lg shadow-amber-500/10 hover:shadow-amber-500/20 active:scale-98 flex items-center justify-center gap-2"
                      >
                        <Volume2 size={16} /> Listen to Hour {chimeTestHour} Chime ({chimeTestHour + 2} Beeps)
                      </button>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div 
                  key="code"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                >
                  <CodeViewer />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Right Column: Connection Guide */}
          <div className="lg:col-span-4 space-y-6">
            <div className="bg-gray-900/80 p-6 rounded-2xl border border-gray-800 sticky top-8">
              <div className="flex border-b border-gray-800 mb-6">
                <button 
                  onClick={() => setRightPanel('wiring')}
                  className={`pb-2 px-3 text-xs md:text-sm font-bold transition-all ${rightPanel === 'wiring' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-500'}`}
                >
                  Wiring
                </button>
                <button 
                  onClick={() => setRightPanel('thermal')}
                  className={`pb-2 px-3 text-xs md:text-sm font-bold transition-all flex items-center gap-1 ${rightPanel === 'thermal' ? 'text-red-400 border-b-2 border-red-400' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  <span className="relative flex h-2 w-2">
                    {temperature >= 75 && (
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    )}
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${temperature >= 75 ? 'bg-red-500' : 'bg-orange-400'}`}></span>
                  </span>
                  Thermal
                </button>
                <button 
                  onClick={() => setRightPanel('backend')}
                  className={`pb-2 px-3 text-xs md:text-sm font-bold transition-all ${rightPanel === 'backend' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-500'}`}
                >
                  Backend
                </button>
              </div>

              {rightPanel === 'wiring' ? (
                <div className="space-y-6">
                  <h2 className="text-xl font-bold mb-6 flex items-center gap-2"><Info size={20} className="text-blue-400" /> Wiring Guide</h2>
                  
                  <section>
                    <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">Passive Buzzer</h4>
                    <ul className="space-y-2 text-sm">
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Positive (+)</span>
                        <span className="font-mono text-blue-400">GPIO 18</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Negative (-)</span>
                        <span className="font-mono text-gray-200">GND</span>
                      </li>
                    </ul>
                  </section>

                  <section>
                    <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">OLED Display (I2C)</h4>
                    <ul className="space-y-2 text-sm">
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">GND</span>
                        <span className="font-mono text-gray-200">GND (Col 6)</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">VCC</span>
                        <span className="font-mono text-gray-200">5V (Col 5)</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">SCL</span>
                        <span className="font-mono text-blue-400">GPIO 22 (R2, C4)</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">SDA</span>
                        <span className="font-mono text-blue-400">GPIO 21 (R5, C4)</span>
                      </li>
                    </ul>
                  </section>

                   <section>
                    <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">Push Button</h4>
                    <ul className="space-y-2 text-sm">
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Terminal 1</span>
                        <span className="font-mono text-blue-400">GPIO 4 (R11, C4)</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Terminal 2</span>
                        <span className="font-mono text-gray-200">GND (R11, C6)</span>
                      </li>
                    </ul>
                  </section>

                  <section>
                    <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">Action Button</h4>
                    <ul className="space-y-2 text-sm">
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Terminal 1</span>
                        <span className="font-mono text-blue-400">GPIO 14 (R12, C4)</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Terminal 2</span>
                        <span className="font-mono text-gray-200">GND (R12, C6)</span>
                      </li>
                    </ul>
                  </section>

                  <section>
                    <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">IR Sensor</h4>
                    <ul className="space-y-2 text-sm">
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">OUT</span>
                        <span className="font-mono text-blue-400">GPIO 13 (R13, C3)</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">VCC / GND</span>
                        <span className="font-mono text-gray-200">5V / GND</span>
                      </li>
                    </ul>
                  </section>

                  <section>
                    <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">Break Button</h4>
                    <ul className="space-y-2 text-sm">
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Terminal 1</span>
                        <span className="font-mono text-blue-400">GPIO 32 (Recommended) or GPIO 34</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Terminal 2</span>
                        <span className="font-mono text-gray-200">GND</span>
                      </li>
                    </ul>
                  </section>

                  <section>
                    <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">RGB LED (Common Cathode)</h4>
                    <ul className="space-y-2 text-sm">
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Red Pin</span>
                        <span className="font-mono text-blue-400">GPIO 25 (R25, C4)</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Green Pin</span>
                        <span className="font-mono text-blue-400">GPIO 26 (R26, C4)</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Blue Pin</span>
                        <span className="font-mono text-blue-400">GPIO 27 (R27, C4)</span>
                      </li>
                      <li className="flex justify-between border-b border-gray-800 pb-1">
                        <span className="text-gray-400">Common Cathode</span>
                        <span className="font-mono text-gray-200">GND</span>
                      </li>
                    </ul>
                  </section>

                  <button 
                    onClick={simulatePowerCut}
                    className="w-full mt-4 py-3 border border-red-900/50 hover:bg-red-900/20 text-red-400 rounded-xl text-sm flex items-center justify-center gap-2 transition-colors"
                  >
                    <Zap size={14} /> Simulate Power Cut
                  </button>
                </div>
              ) : rightPanel === 'thermal' ? (
                <ThermalDiagnostics 
                  isPinConflict={isPinConflict} 
                  setIsPinConflict={setIsPinConflict}
                  isPowerBudgetExceeded={isPowerBudgetExceeded}
                  setIsPowerBudgetExceeded={setIsPowerBudgetExceeded}
                  temperature={temperature}
                  cpuFrequency={cpuFrequency}
                  setCpuFrequency={setCpuFrequency}
                />
              ) : (
                <BackendGuide />
              )}

              <button 
                onClick={reset}
                className="w-full mt-2 py-3 border border-gray-700 hover:bg-gray-800 text-gray-400 rounded-xl text-sm flex items-center justify-center gap-2 transition-colors"
              >
                <RotateCcw size={14} /> Reset Simulation
              </button>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="mt-20 pt-8 border-t border-gray-900 text-center text-gray-600 text-xs">
          Built for Hardware Prototyping & Education
        </footer>
      </div>
    </div>
  );
}
