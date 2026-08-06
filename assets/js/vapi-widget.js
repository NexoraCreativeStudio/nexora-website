/* Shared Vapi Live AI widget — public key, assistant ID, and event handlers
   are copied verbatim, unchanged, from the original working implementation. */
  import * as VapiModule from "https://esm.sh/@vapi-ai/web@2.5.2";
  const VapiSDK = VapiModule.default || VapiModule.Vapi || VapiModule;

  const VAPI_PUBLIC_KEY = "135e1b92-d3da-4d98-96fe-d27f07b86fd8";
  const VAPI_ASSISTANT_ID = "8d7ec5a4-e3b8-4850-8d35-19513928a90b";

  let vapi;
  try {
    vapi = new VapiSDK(VAPI_PUBLIC_KEY);
  } catch (err) {
    console.error('Failed to initialize Vapi SDK:', err);
  }

  const widget = document.getElementById('vapiWidget');
  const statusEl = document.getElementById('vapiStatus');
  const timerEl = document.getElementById('vapiTimer');
  const aiOrb = document.getElementById('vapiAiOrb');
  const userOrb = document.getElementById('vapiUserOrb');
  const endBtn = document.getElementById('vapiEndBtn');
  const closeBtn = document.getElementById('vapiCloseBtn');
  const triggerBtns = Array.from(document.querySelectorAll('.vapi-trigger'));

  let callActive = false;
  let timerInterval = null;
  let secondsElapsed = 0;

  function formatTime(totalSeconds){
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const s = (totalSeconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function startTimer(){
    secondsElapsed = 0;
    timerEl.textContent = '00:00';
    timerInterval = setInterval(() => {
      secondsElapsed++;
      timerEl.textContent = formatTime(secondsElapsed);
    }, 1000);
  }

  function stopTimer(){
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
  }

  function setButtonsActive(active){
    triggerBtns.forEach(btn => {
      btn.classList.toggle('vapi-active', active);
      btn.textContent = active
        ? (btn.dataset.vapiLabelActive || '🔴 End Call')
        : (btn.dataset.vapiLabel || '🎙 Talk to Our Live AI');
    });
  }

  function showWidget(){
    widget.classList.add('visible');
  }

  function hideWidget(){
    widget.classList.remove('visible');
  }

  function resetOrbs(){
    aiOrb.classList.remove('speaking');
    userOrb.classList.remove('speaking');
  }

  function setStatus(text, isError = false){
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
  }

  async function startCall(){
    if (callActive) return;
    if (!vapi) {
      console.error('Vapi SDK not available.');
      return;
    }
    showWidget();
    setStatus('Requesting microphone…');
    resetOrbs();
    try {
      await vapi.start(VAPI_ASSISTANT_ID);
    } catch (err) {
      console.error('Vapi start error:', err);
      setStatus('Could not start the call. Please check microphone permissions and try again.', true);
      setTimeout(() => { if (!callActive) hideWidget(); }, 4000);
    }
  }

  function endCall(){
    try { vapi.stop(); } catch (err) { console.error('Vapi stop error:', err); }
  }

  // Trigger buttons (hero + Live Demo section) open/close the same call
  triggerBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (callActive) {
        endCall();
      } else {
        startCall();
      }
    });
  });

  endBtn.addEventListener('click', endCall);

  closeBtn.addEventListener('click', () => {
    if (callActive) endCall();
    hideWidget();
  });

  if (vapi) {
    vapi.on('call-start', () => {
      callActive = true;
      setStatus('Connected — say hello!');
      setButtonsActive(true);
      startTimer();
    });

    vapi.on('call-end', () => {
      callActive = false;
      stopTimer();
      resetOrbs();
      setButtonsActive(false);
      setStatus('Call ended.');
      setTimeout(hideWidget, 1500);
    });

    vapi.on('speech-start', () => {
      // Assistant has started speaking
      aiOrb.classList.add('speaking');
      userOrb.classList.remove('speaking');
      setStatus('Nexora AI is speaking…');
    });

    vapi.on('speech-end', () => {
      aiOrb.classList.remove('speaking');
      setStatus('Listening…');
    });

    vapi.on('volume-level', (level) => {
      // Reflect visitor's mic volume on the "You" orb while assistant isn't speaking
      if (!aiOrb.classList.contains('speaking')) {
        if (level > 0.15) {
          userOrb.classList.add('speaking');
        } else {
          userOrb.classList.remove('speaking');
        }
      }
    });

    vapi.on('error', (err) => {
      console.error('Vapi error:', err);
      callActive = false;
      stopTimer();
      resetOrbs();
      setButtonsActive(false);
      setStatus('Connection error. Please try again.', true);
      setTimeout(hideWidget, 3000);
    });
  }
