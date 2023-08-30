/*
 * Zed Attack Proxy (ZAP) and its related source files.
 *
 * ZAP is an HTTP/HTTPS proxy for assessing web application security.
 *
 * Copyright 2023 The ZAP Development Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import debounce from 'lodash/debounce';
import Browser from 'webextension-polyfill';
import {
  ZestStatement,
  ZestStatementElementClick,
  ZestStatementElementSendKeys,
  ZestStatementLaunchBrowser,
  ZestStatementSwitchToFrame,
} from '../types/zestScript/ZestStatement';
import {getPath} from './util';
import {STOP_RECORDING, ZEST_SCRIPT} from '../utils/constants';

class Recorder {
  previousDOMState: string;

  curLevel = -1;

  curFrame = 0;

  active = false;

  haveListenersBeenAdded = false;

  floatingWindowInserted = false;

  isNotificationRaised = false;

  async sendZestScriptToZAP(zestStatement: ZestStatement): Promise<number> {
    this.notify(zestStatement);
    return Browser.runtime.sendMessage({
      type: ZEST_SCRIPT,
      data: zestStatement.toJSON(),
    });
  }

  handleFrameSwitches(level: number, frameIndex: number): void {
    if (this.curLevel === level && this.curFrame === frameIndex) {
      return;
    }
    if (this.curLevel > level) {
      while (this.curLevel > level) {
        this.sendZestScriptToZAP(new ZestStatementSwitchToFrame(-1));
        this.curLevel -= 1;
      }
      this.curFrame = frameIndex;
    } else {
      this.curLevel += 1;
      this.curFrame = frameIndex;
      this.sendZestScriptToZAP(new ZestStatementSwitchToFrame(frameIndex));
    }
    if (this.curLevel !== level) {
      console.log('Error in switching frames');
    }
  }

  handleClick(
    params: {level: number; frame: number; element: Document},
    event: Event
  ): void {
    if (!this.shouldRecord(event.target as HTMLElement)) return;
    const {level, frame, element} = params;
    this.handleFrameSwitches(level, frame);
    console.log(event, 'clicked');
    const elementLocator = getPath(event.target as HTMLElement, element);
    this.sendZestScriptToZAP(new ZestStatementElementClick(elementLocator));
    // click on target element
  }

  handleScroll(params: {level: number; frame: number}, event: Event): void {
    if (!this.shouldRecord(event.target as HTMLElement)) return;
    const {level, frame} = params;
    this.handleFrameSwitches(level, frame);
    console.log(event, 'scrolling.. ');
    // scroll the nearest ancestor with scrolling ability
  }

  handleMouseOver(
    params: {level: number; frame: number; element: Document},
    event: Event
  ): void {
    if (!this.shouldRecord(event.target as HTMLElement)) return;
    const {level, frame, element} = params;
    const currentDOMState = element.documentElement.outerHTML;
    if (currentDOMState === this.previousDOMState) {
      return;
    }
    this.previousDOMState = currentDOMState;
    this.handleFrameSwitches(level, frame);
    console.log(event, 'MouseOver');
    // send mouseover event
  }

  handleChange(
    params: {level: number; frame: number; element: Document},
    event: Event
  ): void {
    if (!this.shouldRecord(event.target as HTMLElement)) return;
    const {level, frame, element} = params;
    this.handleFrameSwitches(level, frame);
    console.log(event, 'change', (event.target as HTMLInputElement).value);
    const elementLocator = getPath(event.target as HTMLElement, element);
    this.sendZestScriptToZAP(
      new ZestStatementElementSendKeys(
        elementLocator,
        (event.target as HTMLInputElement).value
      )
    );
  }

  handleResize(): void {
    if (!this.active) return;
    const width =
      window.innerWidth ||
      document.documentElement.clientWidth ||
      document.body.clientWidth;
    const height =
      window.innerHeight ||
      document.documentElement.clientHeight ||
      document.body.clientHeight;
    // send window resize event
    console.log('Window Resize : ', width, height);
  }

  addListenersToDocument(
    element: Document,
    level: number,
    frame: number
  ): void {
    element.addEventListener(
      'click',
      this.handleClick.bind(this, {level, frame, element})
    );
    element.addEventListener(
      'scroll',
      debounce(this.handleScroll.bind(this, {level, frame, element}), 1000)
    );
    element.addEventListener(
      'mouseover',
      this.handleMouseOver.bind(this, {level, frame, element})
    );
    element.addEventListener(
      'change',
      this.handleChange.bind(this, {level, frame, element})
    );

    // Add listeners to all the frames
    const frames = element.querySelectorAll('frame, iframe');
    let i = 0;
    frames.forEach((_frame) => {
      const frameDocument = (_frame as HTMLIFrameElement | HTMLObjectElement)
        .contentWindow?.document;
      if (frameDocument != null) {
        this.addListenersToDocument(frameDocument, level + 1, i);
        i += 1;
      }
    });
  }

  shouldRecord(element: HTMLElement): boolean {
    if (!this.active) return this.active;
    if (element.className === 'ZapfloatingDivElements') return false;
    return true;
  }

  getBrowserName(): string {
    let browserName: string;
    const {userAgent} = navigator;
    if (userAgent.includes('Chrome')) {
      browserName = 'chrome';
    } else {
      browserName = 'firefox';
    }
    return browserName;
  }

  initializationScript(): void {
    // send window resize event to ensure same size
    const browserType = this.getBrowserName();
    const url = window.location.href;
    this.sendZestScriptToZAP(new ZestStatementLaunchBrowser(browserType, url));
    this.handleResize();
  }

  recordUserInteractions(): void {
    console.log('user interactions');
    this.active = true;
    this.previousDOMState = document.documentElement.outerHTML;
    if (this.haveListenersBeenAdded) {
      this.insertFloatingPopup();
      return;
    }
    this.haveListenersBeenAdded = true;
    window.addEventListener('resize', debounce(this.handleResize, 100));
    try {
      this.addListenersToDocument(document, -1, 0);
    } catch (err) {
      // Sometimes throw DOMException: Blocked a frame with current origin from accessing a cross-origin frame.
      console.log(err);
    }
    this.insertFloatingPopup();
  }

  stopRecordingUserInteractions(): void {
    console.log('Stopping Recording User Interactions ...');
    Browser.storage.sync.set({zaprecordingactive: false});
    this.active = false;
    const floatingDiv = document.getElementById('ZapfloatingDiv');
    if (floatingDiv) {
      floatingDiv.style.display = 'none';
    }
  }

  insertFloatingPopup(): void {
    if (this.floatingWindowInserted) {
      const floatingDiv = document.getElementById('ZapfloatingDiv');
      if (floatingDiv) {
        floatingDiv.style.display = 'flex';
        return;
      }
    }

    const fa = document.createElement('style');
    fa.textContent =
      "@font-face { font-family: 'Roboto';font-style: normal;font-weight: 400;" +
      `src: url("${Browser.runtime.getURL(
        'assets/fonts/Roboto-Regular.ttf'
      )}"); };`;

    document.head.appendChild(fa);

    const floatingDiv = document.createElement('div');
    floatingDiv.style.all = 'initial';
    floatingDiv.className = 'ZapfloatingDivElements';
    floatingDiv.id = 'ZapfloatingDiv';
    floatingDiv.style.position = 'fixed';
    floatingDiv.style.top = '100%';
    floatingDiv.style.left = '50%';
    floatingDiv.style.width = '400px';
    floatingDiv.style.height = '100px';
    floatingDiv.style.transform = 'translate(-50%, -105%)';
    floatingDiv.style.backgroundColor = '#f9f9f9';
    floatingDiv.style.border = '2px solid #e74c3c';
    floatingDiv.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.1)';
    floatingDiv.style.zIndex = '999999';
    floatingDiv.style.textAlign = 'center';
    floatingDiv.style.borderRadius = '5px';
    floatingDiv.style.fontFamily = 'Roboto';
    floatingDiv.style.display = 'flex';
    floatingDiv.style.flexDirection = 'column';
    floatingDiv.style.justifyContent = 'center';
    floatingDiv.style.alignItems = 'center';

    const textElement = document.createElement('p');
    textElement.style.all = 'initial';
    textElement.className = 'ZapfloatingDivElements';
    textElement.style.margin = '0';
    textElement.style.zIndex = '999999';
    textElement.style.fontSize = '16px';
    textElement.style.color = '#333';
    textElement.style.fontFamily = 'Roboto';
    textElement.textContent = 'ZAP Browser Extension is Recording...';

    const buttonElement = document.createElement('button');
    buttonElement.style.all = 'initial';
    buttonElement.className = 'ZapfloatingDivElements';
    buttonElement.style.marginTop = '10px';
    buttonElement.style.padding = '8px 15px';
    buttonElement.style.background = '#e74c3c';
    buttonElement.style.color = 'white';
    buttonElement.style.zIndex = '999999';
    buttonElement.style.border = 'none';
    buttonElement.style.borderRadius = '3px';
    buttonElement.style.cursor = 'pointer';
    buttonElement.style.fontFamily = 'Roboto';
    buttonElement.textContent = 'Stop Recording';

    buttonElement.addEventListener('click', () => {
      this.stopRecordingUserInteractions();
      Browser.runtime.sendMessage({type: STOP_RECORDING});
    });

    floatingDiv.appendChild(textElement);
    floatingDiv.appendChild(buttonElement);

    document.body.appendChild(floatingDiv);
    this.floatingWindowInserted = true;

    let isDragging = false;
    let initialMouseX: number;
    let initialMouseY: number;
    let initialDivX: number;
    let initialDivY: number;

    // Mouse down event listener
    floatingDiv.addEventListener('mousedown', (e) => {
      isDragging = true;
      initialMouseX = e.clientX;
      initialMouseY = e.clientY;
      initialDivX = floatingDiv.offsetLeft;
      initialDivY = floatingDiv.offsetTop;
    });

    // Mouse move event listener
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const offsetX = e.clientX - initialMouseX;
      const offsetY = e.clientY - initialMouseY;

      floatingDiv.style.left = `${initialDivX + offsetX}px`;
      floatingDiv.style.top = `${initialDivY + offsetY}px`;
    });

    // Mouse up event listener
    window.addEventListener('mouseup', () => {
      if (!isDragging || floatingDiv.style.left.includes('%')) {
        isDragging = false;
        return;
      }
      const width =
        window.innerWidth ||
        document.documentElement.clientWidth ||
        document.body.clientWidth;

      const height =
        window.innerHeight ||
        document.documentElement.clientHeight ||
        document.body.clientHeight;

      const leftPercent = (parseInt(floatingDiv.style.left) / width) * 100;
      const topPercent = (parseInt(floatingDiv.style.top) / height) * 100;

      floatingDiv.style.left = `${leftPercent}%`;
      floatingDiv.style.top = `${topPercent}%`;
      isDragging = false;
    });
  }

  async notify(stmt: ZestStatement): Promise<void> {
    const notifyMessage = {
      title: '',
      message: '',
    };

    if (stmt instanceof ZestStatementElementClick) {
      notifyMessage.title = 'Click';
      notifyMessage.message = stmt.elementLocator.element;
    } else if (stmt instanceof ZestStatementElementSendKeys) {
      notifyMessage.title = 'Send Keys';
      notifyMessage.message = `${stmt.elementLocator.element}: ${stmt.keys}`;
    } else if (stmt instanceof ZestStatementLaunchBrowser) {
      notifyMessage.title = 'Launch Browser';
      notifyMessage.message = stmt.browserType;
    } else if (stmt instanceof ZestStatementSwitchToFrame) {
      notifyMessage.title = 'Switch To Frame';
      notifyMessage.message = stmt.frameIndex.toString();
    }

    // wait for previous notification to be removed
    if (this.isNotificationRaised) {
      await this.waitForNotificationToClear();
    }
    const floatingDiv = document.getElementById('ZapfloatingDiv');
    if (!floatingDiv) {
      console.log('Floating Div Not Found !');
      return;
    }

    this.isNotificationRaised = true;
    const messageElement = document.createElement('p');
    messageElement.textContent = `${notifyMessage.title}: ${notifyMessage.message}`;
    messageElement.style.all = 'initial';
    messageElement.style.fontSize = '20px';
    messageElement.style.zIndex = '999999';
    messageElement.style.fontFamily = 'Roboto';

    const existingChildElements = Array.from(floatingDiv.children || []);

    floatingDiv.innerHTML = '';

    floatingDiv.appendChild(messageElement);

    setTimeout(() => {
      floatingDiv.removeChild(messageElement);
      existingChildElements.forEach((child) => floatingDiv.appendChild(child));
      this.isNotificationRaised = false;
    }, 1000);
  }

  waitForNotificationToClear(): Promise<number> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.isNotificationRaised) {
          clearInterval(checkInterval);
          resolve(1);
        }
      }, 100);
    });
  }
}

export default Recorder;
