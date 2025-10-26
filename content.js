/**
 * MivaFocus Content Script
 * Filters LMS courses by matching with stored department courses
 * OPTIMIZED VERSION - Fixed all logical errors and improved efficiency
 * UPDATED: Filter dropdowns moved to content UI for direct interaction
 */

class MivaFocusFilter {
  constructor() {
    this.userSettings = null;
    this.departmentCourses = null;
    this.lmsCourses = [];
    this.normalizedDbCourses = new Map(); // Cache for faster matching
    this.stats = { total: 0, visible: 0, hidden: 0 };
    this.isFiltering = false;
    this.initialized = false;
    this.debounceTimer = null;
    this.observer = null;
  }

  async init() {
    if (this.initialized) return;
    
    console.log('[MivaFocus] Initializing...');
    
    try {
      await this.loadUserSettings();
      
      // Check if user has completed onboarding
      if (!this.userSettings.department || !this.userSettings.currentLevel) {
        console.log('[MivaFocus] User needs to complete onboarding');
        this.showOnboardingPrompt();
        return;
      }
      
      // Default filterLevel to currentLevel if not set
      if (!this.userSettings.filterLevel && this.userSettings.currentLevel) {
        this.userSettings.filterLevel = this.userSettings.currentLevel;
        await this.saveUserSettings();
      }
      
      await this.loadDepartmentCourses();
      
      // Wait for DOM to be fully ready before injecting UI
      if (document.readyState === 'loading') {
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
      }
      
      this.injectUI();
      this.extractLMSCourses();
      this.observeDOMChanges();
      
      // Apply filter if enabled
      if (this.userSettings.filterEnabled) {
        await this.applyFilter();
      }
      
      this.initialized = true;
      console.log('[MivaFocus] Initialized successfully');
    } catch (error) {
      console.error('[MivaFocus] Initialization error:', error);
    }
  }

  async loadUserSettings() {
    const defaults = {
      department: null,
      currentLevel: null,
      filterEnabled: false,
      filterLevel: null,
      filterSemester: null,
      showStats: true,
      onboardingComplete: false
    };

    const result = await chrome.storage.sync.get('userSettings');
    this.userSettings = { ...defaults, ...result.userSettings };
  }

  async saveUserSettings() {
    await chrome.storage.sync.set({ userSettings: this.userSettings });
  }

  async loadDepartmentCourses() {
    try {
      const result = await chrome.storage.local.get('departmentCourses');
      
      if (result.departmentCourses && result.departmentCourses.department === this.userSettings.department) {
        this.departmentCourses = result.departmentCourses;
        this.cacheNormalizedCourses();
        console.log('[MivaFocus] Department courses loaded from storage');
      } else if (this.userSettings.department) {
        console.log('[MivaFocus] Fetching full course database...');
        const fullDB = await this.fetchFullDatabase();
        if (fullDB && fullDB.departments && fullDB.departments[this.userSettings.department]) {
          this.departmentCourses = {
            department: this.userSettings.department,
            courses: fullDB.departments[this.userSettings.department].courses
          };
          await chrome.storage.local.set({ departmentCourses: this.departmentCourses });
          this.cacheNormalizedCourses();
          console.log('[MivaFocus] Department courses extracted and stored');
        } else {
          console.warn('[MivaFocus] No courses found for department:', this.userSettings.department);
          this.departmentCourses = null;
        }
      } else {
        console.log('[MivaFocus] No department set, skipping course load');
        this.departmentCourses = null;
      }
    } catch (error) {
      console.error('[MivaFocus] Failed to load department courses:', error);
      this.departmentCourses = null;
    }
  }

  async fetchFullDatabase() {
    const githubRawUrl = 'https://raw.githubusercontent.com/trust914/MivaFocus_Scraper/master/courses_database.json';
    try {
      const response = await fetch(githubRawUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: Failed to fetch database`);
      }
      return await response.json();
    } catch (error) {
      console.error('[MivaFocus] Database fetch error:', error);
      return null;
    }
  }

  cacheNormalizedCourses() {
    this.normalizedDbCourses.clear();
    
    if (!this.departmentCourses || !this.departmentCourses.courses) return;
    
    Object.values(this.departmentCourses.courses).forEach(levelData => {
      if (levelData && typeof levelData === 'object') {
        Object.values(levelData).forEach(semesterCourses => {
          if (Array.isArray(semesterCourses)) {
            semesterCourses.forEach(course => {
              if (course && course.title) {
                const normalized = this.normalizeTitle(course.title).toLowerCase();
                const codeMatch = course.title.match(/\b([A-Z]{3})\s*(\d{3})\b/i);
                const courseCode = codeMatch ? `${codeMatch[1]}${codeMatch[2]}`.toLowerCase() : null;
                
                this.normalizedDbCourses.set(course.title, {
                  original: course.title,
                  normalized: normalized,
                  code: courseCode
                });
              }
            });
          }
        });
      }
    });
    
    console.log(`[MivaFocus] Cached ${this.normalizedDbCourses.size} normalized course titles`);
  }

  showOnboardingPrompt() {
    // Prevent duplicate overlays
    if (document.getElementById('mivafocus-onboarding-overlay')) return;
    
    const overlay = document.createElement('div');
    overlay.id = 'mivafocus-onboarding-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
      background: rgba(0,0,0,0.5); z-index: 10000; display: flex; 
      align-items: center; justify-content: center;
    `;
    overlay.innerHTML = `
      <div class="mf-onboarding-modal" style="
        background: white; padding: 2rem; border-radius: 8px; max-width: 400px; 
        text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.2);
      ">
        <div class="mf-onboarding-header">
          <h2 style="margin: 0 0 0.5rem 0; color: #1e40af;">⚡ Welcome to MivaFocus!</h2>
          <p style="margin: 0 0 1.5rem 0; color: #6b7280;">Let's set up your course filter</p>
        </div>
        <div class="mf-onboarding-content">
          <p style="text-align: center; margin-bottom: 20px; color: #374151;">
            Click the extension icon in your toolbar to select your department and current level.
          </p>
          <div style="text-align: center; margin-bottom: 1.5rem;">
            <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" style="margin: 0 auto;">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
        </div>
        <button id="mf-onboarding-dismiss" style="
          background: #3b82f6; color: white; border: none; padding: 0.75rem 1.5rem; 
          border-radius: 6px; cursor: pointer; font-weight: 500;
        ">Got it!</button>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    document.getElementById('mf-onboarding-dismiss').addEventListener('click', () => {
      overlay.remove();
    });
  }

  extractLMSCourses() {
    const courseElements = this.findCourseElements();
    this.lmsCourses = [];
    
    courseElements.forEach(el => {
      const title = this.extractCourseTitle(el);
      if (title && title.length > 5) {
        this.lmsCourses.push({
          element: el,
          title: title,
          normalizedTitle: this.normalizeTitle(title).toLowerCase()
        });
      }
    });
    
    console.log(`[MivaFocus] Extracted ${this.lmsCourses.length} courses from LMS`);
  }

  findCourseElements() {
    // Target the exact structure from the HTML
    const primarySelector = '.card.dashboard-card[role="listitem"][data-region="course-content"]';
    let elements = Array.from(document.querySelectorAll(primarySelector));
    
    console.log(`[MivaFocus] Primary selector found ${elements.length} elements`);
    
    // Fallback selectors
    if (elements.length === 0) {
      const fallbackSelectors = [
        '.dashboard-card[data-region="course-content"]',
        '.card[role="listitem"][data-course-id]',
        'div[data-region="course-content"]',
        '.dashboard-card'
      ];
      
      for (const selector of fallbackSelectors) {
        elements = Array.from(document.querySelectorAll(selector));
        if (elements.length > 0) {
          console.log(`[MivaFocus] Fallback selector "${selector}" found ${elements.length} elements`);
          break;
        }
      }
    }

    // Validate elements have course structure
    const validated = elements.filter(el => {
      const hasMultiline = el.querySelector('.multiline');
      const hasCoursename = el.querySelector('.coursename');
      const hasCourseLink = el.querySelector('a[href*="/course/view.php"]');
      return hasMultiline || hasCoursename || hasCourseLink;
    });

    console.log(`[MivaFocus] Validated ${validated.length} course elements`);
    return validated.length > 0 ? validated : elements;
  }

  extractCourseTitle(courseEl) {
    // Priority order based on HTML structure
    const strategies = [
      () => courseEl.querySelector('.multiline')?.textContent.trim(),
      () => courseEl.querySelector('a.coursename')?.textContent.trim(),
      () => courseEl.querySelector('.coursename')?.textContent.trim(),
      () => courseEl.querySelector('a[href*="/course/view.php"]')?.textContent.trim(),
      () => courseEl.querySelector('span[title]')?.title.trim()
    ];

    for (const strategy of strategies) {
      try {
        const text = strategy();
        if (text && text.length > 5) {
          console.log(`[MivaFocus] Extracted title: "${text}"`);
          return text;
        }
      } catch (e) {
        continue;
      }
    }

    console.warn(`[MivaFocus] Failed to extract title from element`);
    return null;
  }

  normalizeTitle(title) {
    return title
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  injectUI() {
    // Prevent duplicate UI
    if (document.getElementById('mivafocus-control-bar')) return;
    
    const controlBar = document.createElement('div');
    controlBar.id = 'mivafocus-control-bar';
    controlBar.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; z-index: 1000; 
      background: #f8fafc; border-bottom: 1px solid #e2e8f0; padding: 0.5rem 1rem;
      display: flex; align-items: center; justify-content: space-between; 
      font-family: system-ui, sans-serif; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    `;
    controlBar.innerHTML = `
      <div style="display: flex; align-items: center; gap: 1rem;">
        <div style="display: flex; align-items: center; gap: 0.5rem; font-weight: 600; color: #1e40af;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 3L2 12l4 2 14-9-10 10 6 2z"/>
          </svg>
          <span>MivaFocus</span>
        </div>
        <!-- Filter Controls -->
        <div style="display: flex; align-items: center; gap: 0.5rem; background: white; padding: 0.25rem 0.75rem; border-radius: 6px; border: 1px solid #e2e8f0;">
          <label style="font-size: 0.75rem; color: #64748b; white-space: nowrap;">Filter:</label>
          <select id="mf-filter-level" style="padding: 0.25rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.875rem; min-width: 80px;">
            <option value="">All Levels</option>
            <option value="100">100 Level</option>
            <option value="200">200 Level</option>
            <option value="300">300 Level</option>
            <option value="400">400 Level</option>
            <option value="500">500 Level</option>
          </select>
          <select id="mf-filter-semester" style="padding: 0.25rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.875rem; min-width: 120px;">
            <option value="">All Semesters</option>
            <option value="first_semester">First Semester</option>
            <option value="second_semester">Second Semester</option>
          </select>
        </div>
        <div style="display: flex; align-items: center; gap: 1rem;">
          <button id="mf-toggle-filter" style="
            background: ${this.userSettings.filterEnabled ? '#ef4444' : '#3b82f6'}; 
            color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; 
            cursor: pointer; font-size: 0.875rem; transition: all 0.2s;
          ">
            ${this.userSettings.filterEnabled ? 'Disable Filter' : 'Enable Filter'}
          </button>
          <div style="display: ${this.userSettings.showStats ? 'flex' : 'none'}; 
                      align-items: center; gap: 0.5rem; font-size: 0.875rem; color: #64748b;">
            <span><strong id="mf-visible-count" style="color: #059669;">0</strong> visible</span>
            <span style="opacity: 0.5;">|</span>
            <span><strong id="mf-hidden-count" style="color: #dc2626;">0</strong> hidden</span>
          </div>
        </div>
      </div>
    `;

    document.body.insertBefore(controlBar, document.body.firstChild);
    
    // Add padding to body to account for fixed bar
    document.body.style.paddingTop = '50px';
    
    // Populate and set initial values for dropdowns
    const levelSelect = document.getElementById('mf-filter-level');
    const semesterSelect = document.getElementById('mf-filter-semester');
    
    if (levelSelect) {
      levelSelect.value = this.userSettings.filterLevel || '';
    }
    if (semesterSelect) {
      semesterSelect.value = this.userSettings.filterSemester || '';
    }
    
    this.attachEventListeners();
  }

  attachEventListeners() {
    const toggleBtn = document.getElementById('mf-toggle-filter');
    const levelSelect = document.getElementById('mf-filter-level');
    const semesterSelect = document.getElementById('mf-filter-semester');
    
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this.toggleFilter());
    }
    
    if (levelSelect) {
      levelSelect.addEventListener('change', (e) => {
        this.userSettings.filterLevel = e.target.value;
        this.saveUserSettings();
        if (this.userSettings.filterEnabled) {
          this.applyFilter();
        }
      });
    }
    
    if (semesterSelect) {
      semesterSelect.addEventListener('change', (e) => {
        this.userSettings.filterSemester = e.target.value;
        this.saveUserSettings();
        if (this.userSettings.filterEnabled) {
          this.applyFilter();
        }
      });
    }

    // Message listener for popup communication
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      (async () => {
        try {
          switch (request.action) {
            case 'updateSettings':
              await this.handleSettingsUpdate(request.settings);
              sendResponse({ success: true });
              break;
            case 'updateDepartmentCourses':
              await this.handleDepartmentCoursesUpdate(request.courses);
              sendResponse({ success: true });
              break;
            case 'getStats':
              sendResponse(this.stats);
              break;
            case 'getLMSCourses':
              this.extractLMSCourses();
              sendResponse({ 
                courses: this.lmsCourses.map(c => ({ title: c.title })),
                count: this.lmsCourses.length 
              });
              break;
            default:
              sendResponse({ success: false, error: 'Unknown action' });
          }
        } catch (error) {
          console.error('[MivaFocus] Message handler error:', error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true; // Keep channel open for async response
    });
  }

  async toggleFilter() {
    this.userSettings.filterEnabled = !this.userSettings.filterEnabled;
    await this.saveUserSettings();
    
    const toggleBtn = document.getElementById('mf-toggle-filter');
    if (toggleBtn) {
      toggleBtn.textContent = this.userSettings.filterEnabled ? 'Disable Filter' : 'Enable Filter';
      toggleBtn.style.background = this.userSettings.filterEnabled ? '#ef4444' : '#3b82f6';
    }

    await this.applyFilter();
  }

  async handleSettingsUpdate(settings) {
    const oldDept = this.userSettings.department;
    this.userSettings = { ...this.userSettings, ...settings };
    await this.saveUserSettings();
    
    // Default filterLevel to currentLevel if not set
    if (!this.userSettings.filterLevel && this.userSettings.currentLevel) {
      this.userSettings.filterLevel = this.userSettings.currentLevel;
      await this.saveUserSettings();
    }
    
    // Reload courses if department changed
    if (oldDept !== this.userSettings.department) {
      await this.loadDepartmentCourses();
    }
    
    // Re-apply filter with new settings
    if (this.userSettings.filterEnabled) {
      await this.applyFilter();
    }
    
    // Update dropdown values
    const levelSelect = document.getElementById('mf-filter-level');
    const semesterSelect = document.getElementById('mf-filter-semester');
    
    if (levelSelect) levelSelect.value = this.userSettings.filterLevel || '';
    if (semesterSelect) semesterSelect.value = this.userSettings.filterSemester || '';
  }

  async handleDepartmentCoursesUpdate(courses) {
    this.departmentCourses = courses;
    await chrome.storage.local.set({ departmentCourses: courses });
    this.cacheNormalizedCourses();
    
    if (this.userSettings.filterEnabled) {
      await this.applyFilter();
    }
  }

  async applyFilter() {
    if (this.isFiltering) {
      console.log('[MivaFocus] Filter already in progress, skipping...');
      return;
    }
    this.isFiltering = true;

    try {
      // Re-extract to catch any new courses
      this.extractLMSCourses();

      if (this.lmsCourses.length === 0) {
        console.warn('[MivaFocus] No courses found to filter');
        return;
      }

      this.stats.total = this.lmsCourses.length;
      this.stats.visible = 0;
      this.stats.hidden = 0;

      // Batch DOM updates using requestAnimationFrame
      const updates = this.lmsCourses.map(lmsCourse => ({
        element: lmsCourse.element,
        shouldShow: this.shouldShowCourse(lmsCourse)
      }));

      requestAnimationFrame(() => {
        updates.forEach(({ element, shouldShow }) => {
          if (this.userSettings.filterEnabled) {
            if (shouldShow) {
              element.style.removeProperty('display');
              element.setAttribute('data-mivafocus-filtered', 'false');
              this.stats.visible++;
            } else {
              element.style.display = 'none';
              element.setAttribute('data-mivafocus-filtered', 'true');
              this.stats.hidden++;
            }
          } else {
            element.style.removeProperty('display');
            element.removeAttribute('data-mivafocus-filtered');
            this.stats.visible++;
          }
        });

        this.updateStatsDisplay();
        console.log('[MivaFocus] Filter applied:', this.stats);
      });

    } catch (error) {
      console.error('[MivaFocus] Filter error:', error);
    } finally {
      this.isFiltering = false;
    }
  }

  shouldShowCourse(lmsCourse) {
    if (!this.departmentCourses || !this.departmentCourses.courses) {
      return true; // Show all if no department courses
    }

    const { filterLevel, filterSemester, currentLevel } = this.userSettings;
    const effectiveLevel = filterLevel || currentLevel;
    
    let coursesToMatch = [];
    
    if (effectiveLevel && filterSemester) {
      // Specific level and semester
      const levelKey = `${effectiveLevel}_Level`;
      const levelData = this.departmentCourses.courses[levelKey];
      if (levelData && levelData[filterSemester]) {
        coursesToMatch = levelData[filterSemester];
      }
    } else if (effectiveLevel) {
      // All semesters for specific level
      const levelKey = `${effectiveLevel}_Level`;
      const levelData = this.departmentCourses.courses[levelKey];
      if (levelData) {
        Object.values(levelData).forEach(semesterCourses => {
          if (Array.isArray(semesterCourses)) {
            coursesToMatch = coursesToMatch.concat(semesterCourses);
          }
        });
      }
    } else if (filterSemester) {
      // Specific semester across all levels
      Object.values(this.departmentCourses.courses).forEach(levelData => {
        if (levelData && levelData[filterSemester]) {
          coursesToMatch = coursesToMatch.concat(levelData[filterSemester]);
        }
      });
    } else {
      // Show all courses
      Object.values(this.departmentCourses.courses).forEach(levelData => {
        if (levelData && typeof levelData === 'object') {
          Object.values(levelData).forEach(semesterCourses => {
            if (Array.isArray(semesterCourses)) {
              coursesToMatch = coursesToMatch.concat(semesterCourses);
            }
          });
        }
      });
    }

    return this.matchCourse(lmsCourse, coursesToMatch);
  }

  matchCourse(lmsCourse, coursesToMatch) {
    const lmsTitleLower = lmsCourse.normalizedTitle;
    const lmsCourseCode = this.extractCourseCode(lmsCourse.title);
    
    for (const dbCourse of coursesToMatch) {
      if (!dbCourse || !dbCourse.title) continue;
      
      const cachedData = this.normalizedDbCourses.get(dbCourse.title);
      const dbTitleLower = cachedData?.normalized || this.normalizeTitle(dbCourse.title).toLowerCase();
      const dbCourseCode = cachedData?.code || this.extractCourseCode(dbCourse.title);
      
      // Priority 1: Course code match (most reliable)
      if (lmsCourseCode && dbCourseCode && lmsCourseCode === dbCourseCode) {
        return true;
      }
      
      // Priority 2: Exact normalized title match
      if (lmsTitleLower === dbTitleLower) {
        return true;
      }
      
      // Priority 3: Substring match
      if (lmsTitleLower.includes(dbTitleLower) || dbTitleLower.includes(lmsTitleLower)) {
        return true;
      }
      
      // Priority 4: Fuzzy word matching
      if (this.fuzzyMatch(lmsTitleLower, dbTitleLower)) {
        return true;
      }
    }
    
    return false;
  }

  extractCourseCode(title) {
    const match = title.match(/\b([A-Z]{3})\s*(\d{3})\b/i);
    return match ? `${match[1]}${match[2]}`.toLowerCase() : null;
  }

  fuzzyMatch(str1, str2) {
    const words1 = str1.split(/\s+/).filter(w => w.length > 3);
    const words2 = str2.split(/\s+/).filter(w => w.length > 3);
    
    if (words1.length < 2 || words2.length < 2) return false;
    
    const matchingWords = words1.filter(w => words2.includes(w));
    const matchRatio = matchingWords.length / Math.min(words1.length, words2.length);
    
    return matchRatio >= 0.6;
  }

  updateStatsDisplay() {
    const visibleEl = document.getElementById('mf-visible-count');
    const hiddenEl = document.getElementById('mf-hidden-count');
    
    if (visibleEl) visibleEl.textContent = this.stats.visible;
    if (hiddenEl) hiddenEl.textContent = this.stats.hidden;
  }

  observeDOMChanges() {
    if (this.observer) return; // Prevent duplicate observers
    
    this.observer = new MutationObserver((mutations) => {
      const relevantChange = mutations.some(mutation => {
        if (mutation.type === 'childList') {
          return Array.from(mutation.addedNodes).some(node => {
            return node.nodeType === 1 && (
              node.classList?.contains('dashboard-card') ||
              node.querySelector?.('.dashboard-card') ||
              (node.hasAttribute?.('data-region') && 
               node.getAttribute('data-region').includes('course'))
            );
          });
        }
        return false;
      });

      if (!relevantChange || !this.userSettings.filterEnabled || this.isFiltering) return;

      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        console.log('[MivaFocus] DOM changed, re-applying filter...');
        this.extractLMSCourses();
        this.applyFilter();
      }, 300);
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });

    console.log('[MivaFocus] DOM observer initialized');
  }
}

// Initialize on page load
(function() {
  const filter = new MivaFocusFilter();
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => filter.init());
  } else {
    filter.init();
  }
})();