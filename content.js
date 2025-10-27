/**
 * MivaFocus Content Script
 * Filters LMS courses by department with level/semester controls on the page
 * Registration only requires department selection
 * Injects filter UI into existing LMS page for integration
 * IMPROVED: Use explicit course.code from DB for matching, normalize by removing spaces
 */

class MivaFocusFilter {
  constructor() {
    this.userSettings = null;
    this.departmentCourses = null;
    this.lmsCourses = [];
    this.normalizedDbCourses = new Map();
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
      
      // Check if user has completed onboarding (department selected)
      if (!this.userSettings.department) {
        console.log('[MivaFocus] User needs to complete onboarding');
        this.showOnboardingPrompt();
        return;
      }
      
      await this.loadDepartmentCourses();
      
      // Wait for DOM to be ready
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
                const courseCode = course.code ? course.code.replace(/\s+/g, '').toLowerCase() : null;
                
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
    if (document.getElementById('mivafocus-onboarding-overlay')) return;
    
    const overlay = document.createElement('div');
    overlay.id = 'mivafocus-onboarding-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
      background: rgba(0,0,0,0.6); z-index: 10000; display: flex; 
      align-items: center; justify-content: center; backdrop-filter: blur(4px);
    `;
    overlay.innerHTML = `
      <div style="
        background: white; padding: 2.5rem; border-radius: 12px; max-width: 450px; 
        text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      ">
        <div style="margin-bottom: 1.5rem;">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" style="margin: 0 auto;">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <h2 style="margin: 0 0 0.75rem 0; color: #1e40af; font-size: 1.5rem;">⚡ Welcome to MivaFocus!</h2>
        <p style="margin: 0 0 1.5rem 0; color: #6b7280; font-size: 1rem;">
          Filter your LMS courses by department and level
        </p>
        <p style="margin: 0 0 2rem 0; color: #374151; line-height: 1.6;">
          Click the <strong>MivaFocus extension icon</strong> in your browser toolbar to select your department and get started.
        </p>
        <button id="mf-onboarding-dismiss" style="
          background: #3b82f6; color: white; border: none; padding: 0.875rem 2rem; 
          border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 1rem;
          transition: background 0.2s;
        " onmouseover="this.style.background='#2563eb'" onmouseout="this.style.background='#3b82f6'">
          Got it!
        </button>
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
        const normalizedFull = this.normalizeTitle(title).toLowerCase();
        const codeMatch = title.match(/\b([A-Z]{3})\s*(\d{3})\b/i);
        const courseCode = codeMatch ? `${codeMatch[1]}${codeMatch[2]}`.toLowerCase() : null;
        
        let descriptiveTitle = title;
        if (codeMatch) {
          descriptiveTitle = title.replace(codeMatch[0], '').replace(/^\s*[-–—:\s]*/, '').trim();
        }
        const normalizedDesc = this.normalizeTitle(descriptiveTitle).toLowerCase();
        
        this.lmsCourses.push({
          element: el,
          title,
          normalizedFull,
          normalizedDesc,
          code: courseCode
        });
      }
    });
    
    console.log(`[MivaFocus] Extracted ${this.lmsCourses.length} courses from LMS`);
  }

  findCourseElements() {
    const primarySelector = '.card.dashboard-card[role="listitem"][data-region="course-content"]';
    let elements = Array.from(document.querySelectorAll(primarySelector));
    
    console.log(`[MivaFocus] Primary selector found ${elements.length} elements`);
    
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
          return text;
        }
      } catch (e) {
        continue;
      }
    }

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
    if (document.getElementById('mivafocus-control-bar')) return;

    const wrapper = document.querySelector('.all-filter-wrapper');
    if (!wrapper) {
      console.warn('[MivaFocus] Could not find .all-filter-wrapper, falling back to fixed bar');
      this.injectFallbackUI();
      return;
    }

    const navSearchSort = wrapper.querySelector('.nav-search-sort-selector');
    if (!navSearchSort) {
      console.warn('[MivaFocus] Could not find .nav-search-sort-selector, falling back to fixed bar');
      this.injectFallbackUI();
      return;
    }

    const controlContainer = document.createElement('div');
    controlContainer.id = 'mivafocus-control-bar';
    controlContainer.className = 'd-flex align-items-center';
    controlContainer.style.marginLeft = '1rem';
    controlContainer.innerHTML = `
      <div class="d-flex flex-wrap align-items-center">
        <div class="dropdown">
          <button id="mivafocus-filter-dropdown" type="button" class="btn dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false" aria-label="MivaFocus filter drop-down menu">
            <span>MivaFocus Filter</span>
          </button>
          <ul class="dropdown-menu" aria-labelledby="mivafocus-filter-dropdown">
            <li class="dropdown-item d-flex flex-column p-3" style="width: 300px;">
              <label for="mf-filter-level" class="font-weight-bold mb-1">Filter by Level</label>
              <select id="mf-filter-level" class="form-control mb-2">
                <option value="">All Levels</option>
                <option value="100">100 Level</option>
                <option value="200">200 Level</option>
                <option value="300">300 Level</option>
                <option value="400">400 Level</option>
                <option value="500">500 Level</option>
              </select>
              <label for="mf-filter-semester" class="font-weight-bold mb-1">Filter by Semester</label>
              <select id="mf-filter-semester" class="form-control mb-2">
                <option value="">All Semesters</option>
                <option value="first_semester">First Semester</option>
                <option value="second_semester">Second Semester</option>
              </select>
            </li>
          </ul>
        </div>
      </div>
      <button id="mf-toggle-filter" class="btn ${this.userSettings.filterEnabled ? 'btn-danger' : 'btn-primary'} ml-2">
        ${this.userSettings.filterEnabled ? 'Disable Filter' : 'Enable Filter'}
      </button>
      <div id="mf-stats" class="d-flex align-items-center ml-2 ${this.userSettings.showStats ? '' : 'd-none'}" style="font-size: 0.875rem; color: #64748b;">
        <span>Visible: <strong id="mf-visible-count" style="color: #059669;">0</strong></span>
        <span style="margin: 0 0.5rem;">|</span>
        <span>Hidden: <strong id="mf-hidden-count" style="color: #dc2626;">0</strong></span>
      </div>
    `;

    navSearchSort.appendChild(controlContainer);

    // Prevent dropdown from closing on inner clicks
    const dropdownMenu = controlContainer.querySelector('.dropdown-menu');
    if (dropdownMenu) {
      dropdownMenu.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    // Set initial values
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

  injectFallbackUI() {
    const controlBar = document.createElement('div');
    controlBar.id = 'mivafocus-control-bar';
    controlBar.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; z-index: 1000; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
      border-bottom: 2px solid rgba(255,255,255,0.2); padding: 0.75rem 1.5rem;
      display: flex; align-items: center; justify-content: space-between; 
      font-family: system-ui, -apple-system, sans-serif; 
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    
    controlBar.innerHTML = `
      <div style="display: flex; align-items: center; gap: 1.5rem; flex: 1;">
        <div style="display: flex; align-items: center; gap: 0.5rem; font-weight: 700; color: white; font-size: 1.125rem;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
          <span>MivaFocus</span>
        </div>
        
        <!-- Filter Controls -->
        <div style="display: flex; align-items: center; gap: 0.75rem; background: rgba(255,255,255,0.95); padding: 0.5rem 1rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
          </svg>
          <select id="mf-filter-level" style="padding: 0.375rem 0.75rem; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.875rem; min-width: 100px; background: white; cursor: pointer;">
            <option value="">All Levels</option>
            <option value="100">100 Level</option>
            <option value="200">200 Level</option>
            <option value="300">300 Level</option>
            <option value="400">400 Level</option>
            <option value="500">500 Level</option>
          </select>
          <select id="mf-filter-semester" style="padding: 0.375rem 0.75rem; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.875rem; min-width: 140px; background: white; cursor: pointer;">
            <option value="">All Semesters</option>
            <option value="first_semester">First Semester</option>
            <option value="second_semester">Second Semester</option>
          </select>
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 1rem;">
        <button id="mf-toggle-filter" style="
          background: ${this.userSettings.filterEnabled ? '#ef4444' : 'rgba(255,255,255,0.95)'}; 
          color: ${this.userSettings.filterEnabled ? 'white' : '#1e293b'}; 
          border: none; padding: 0.625rem 1.25rem; border-radius: 8px; 
          cursor: pointer; font-size: 0.875rem; font-weight: 600; 
          transition: all 0.2s; box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        ">
          ${this.userSettings.filterEnabled ? '✕ Disable Filter' : '✓ Enable Filter'}
        </button>
        
        <div style="
          display: ${this.userSettings.showStats ? 'flex' : 'none'}; 
          align-items: center; gap: 1rem; padding: 0.5rem 1rem; 
          background: rgba(255,255,255,0.95); border-radius: 8px; 
          box-shadow: 0 2px 8px rgba(0,0,0,0.1); font-size: 0.875rem;
        ">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="color: #64748b;">Visible:</span>
            <strong id="mf-visible-count" style="color: #059669; font-size: 1rem;">0</strong>
          </div>
          <div style="width: 1px; height: 20px; background: #e2e8f0;"></div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="color: #64748b;">Hidden:</span>
            <strong id="mf-hidden-count" style="color: #dc2626; font-size: 1rem;">0</strong>
          </div>
        </div>
      </div>
    `;

    document.body.insertBefore(controlBar, document.body.firstChild);
    document.body.style.paddingTop = '70px';
    
    // Set initial dropdown values
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
            case 'resetSettings':
              await this.handleReset();
              sendResponse({ success: true });
              break;
            case 'getStats':
              sendResponse(this.stats);
              break;
            default:
              sendResponse({ success: false, error: 'Unknown action' });
          }
        } catch (error) {
          console.error('[MivaFocus] Message handler error:', error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    });
  }

  async toggleFilter() {
    this.userSettings.filterEnabled = !this.userSettings.filterEnabled;
    await this.saveUserSettings();
    
    const toggleBtn = document.getElementById('mf-toggle-filter');
    if (toggleBtn) {
      const isEnabled = this.userSettings.filterEnabled;
      toggleBtn.textContent = isEnabled ? 'Disable Filter' : 'Enable Filter';
      toggleBtn.className = `btn ${isEnabled ? 'btn-danger' : 'btn-primary'} ml-2`;
    }

    await this.applyFilter();
  }

  async handleSettingsUpdate(settings) {
    const oldDept = this.userSettings.department;
    this.userSettings = { ...this.userSettings, ...settings };
    await this.saveUserSettings();
    
    // Reload courses if department changed
    if (oldDept !== this.userSettings.department) {
      await this.loadDepartmentCourses();
      
      // Reinitialize UI if department was just set
      if (!oldDept && this.userSettings.department) {
        const overlay = document.getElementById('mivafocus-onboarding-overlay');
        if (overlay) overlay.remove();
        
        this.injectUI();
        this.extractLMSCourses();
      }
    }
    
    // Update UI elements
    const toggleBtn = document.getElementById('mf-toggle-filter');
    if (toggleBtn) {
      const isEnabled = this.userSettings.filterEnabled;
      toggleBtn.textContent = isEnabled ? 'Disable Filter' : 'Enable Filter';
      toggleBtn.className = `btn ${isEnabled ? 'btn-danger' : 'btn-primary'} ml-2`;
    }
    
    const levelSelect = document.getElementById('mf-filter-level');
    const semesterSelect = document.getElementById('mf-filter-semester');
    
    if (levelSelect) levelSelect.value = this.userSettings.filterLevel || '';
    if (semesterSelect) semesterSelect.value = this.userSettings.filterSemester || '';
    
    // Apply filter with new settings
    if (this.userSettings.filterEnabled) {
      await this.applyFilter();
    }
  }

  async handleReset() {
    // Remove UI
    const controlBar = document.getElementById('mivafocus-control-bar');
    if (controlBar) {
      controlBar.remove();
    }
    document.body.style.paddingTop = '';
    
    // Reset state
    this.userSettings = {
      department: null,
      filterEnabled: false,
      filterLevel: null,
      filterSemester: null,
      showStats: true,
      onboardingComplete: false
    };
    this.departmentCourses = null;
    this.initialized = false;
    
    // Show onboarding prompt
    this.showOnboardingPrompt();
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
        this.isFiltering = false;
        return;
      }

      this.stats.total = this.lmsCourses.length;
      this.stats.visible = 0;
      this.stats.hidden = 0;

      // Batch DOM updates
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
      return true;
    }

    const { filterLevel, filterSemester } = this.userSettings;
    let coursesToMatch = [];
    
    if (filterLevel && filterSemester) {
      // Specific level and semester
      const levelKey = `${filterLevel}_Level`;
      const levelData = this.departmentCourses.courses[levelKey];
      if (levelData && levelData[filterSemester]) {
        coursesToMatch = levelData[filterSemester];
      }
    } else if (filterLevel) {
      // All semesters for specific level
      const levelKey = `${filterLevel}_Level`;
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
      // Show all courses in department
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
    const lmsFullLower = lmsCourse.normalizedFull;
    const lmsDescLower = lmsCourse.normalizedDesc;
    const lmsCode = lmsCourse.code;
    
    // Build optimized lookup structures
    const dbCodes = new Set();
    const dbTitleMap = new Map();
    
    for (const dbCourse of coursesToMatch) {
      if (!dbCourse || !dbCourse.title) continue;
      const dbData = this.normalizedDbCourses.get(dbCourse.title);
      if (!dbData) continue;
      
      if (dbData.code) {
        dbCodes.add(dbData.code);
      }
      dbTitleMap.set(dbData.normalized, dbData);
    }
    
    // Priority 1: EXACT course code match (100% confidence)
    if (lmsCode && dbCodes.has(lmsCode)) {
      return true;
    }
    
    // Priority 2: EXACT descriptive title match (100% confidence)
    if (dbTitleMap.has(lmsDescLower)) {
      return true;
    }
    
    // Priority 3: EXACT full title match (100% confidence)
    if (dbTitleMap.has(lmsFullLower)) {
      return true;
    }
    
    // Priority 4: Smart fuzzy matching with sequence detection
    for (const [dbNormalized, dbData] of dbTitleMap.entries()) {
      // Extract all words (>2 chars for more inclusivity)
      const lmsWords = lmsDescLower.split(/\s+/).filter(w => w.length > 2);
      const dbWords = dbNormalized.split(/\s+/).filter(w => w.length > 2);
      
      // Skip if either has too few words
      if (lmsWords.length < 2 || dbWords.length < 2) continue;
      
      // Separate numeric/roman numerals from regular words
      const lmsNumeric = this.extractSequenceNumbers(lmsDescLower);
      const dbNumeric = this.extractSequenceNumbers(dbNormalized);
      
      // Filter out numeric tokens from word lists
      const lmsTextWords = lmsWords.filter(w => !this.isNumericToken(w));
      const dbTextWords = dbWords.filter(w => !this.isNumericToken(w));
      
      // If both courses have sequence numbers, they must match exactly
      if (lmsNumeric.length > 0 && dbNumeric.length > 0) {
        const lmsNumStr = lmsNumeric.sort().join(',');
        const dbNumStr = dbNumeric.sort().join(',');
        
        if (lmsNumStr !== dbNumStr) {
          continue; // Different sequence numbers, not a match
        }
      }
      
      // Calculate word match ratio (using text words only)
      const lmsSet = new Set(lmsTextWords);
      const dbSet = new Set(dbTextWords);
      const matchingWords = [...lmsSet].filter(w => dbSet.has(w));
      
      // Use smaller set size as denominator for more lenient matching
      const minWords = Math.min(lmsSet.size, dbSet.size);
      const matchRatio = minWords > 0 ? matchingWords.length / minWords : 0;
      
      // Dynamic threshold based on word count
      let requiredRatio = 0.75; // Base threshold
      let minMatchingWords = 2;
      
      if (minWords >= 4) {
        // Longer titles can be more flexible
        requiredRatio = 0.7;
        minMatchingWords = 3;
      } else if (minWords === 2) {
        // Short titles need exact match
        requiredRatio = 1.0;
        minMatchingWords = 2;
      }
      
      if (matchRatio >= requiredRatio && matchingWords.length >= minMatchingWords) {
        return true;
      }
    }
    
    return false;
  }
  
  extractSequenceNumbers(str) {
    // Extract all numeric sequences and roman numerals
    const matches = str.match(/\b\d+\b|\bi{1,3}v?\b|\biv\b|\bv\b|\bvi{1,3}\b|\bix\b|\bx\b/gi) || [];
    return matches.map(m => this.normalizeSequenceNumber(m));
  }
  
  normalizeSequenceNumber(token) {
    // Convert roman numerals to numbers for comparison
    const romanMap = {
      'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5,
      'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10
    };
    
    const lower = token.toLowerCase();
    return romanMap[lower] !== undefined ? romanMap[lower].toString() : token;
  }
  
  isNumericToken(word) {
    // Check if word is a number or roman numeral
    return /^\d+$/.test(word) || /^i{1,3}v?$|^iv$|^v$|^vi{1,3}$|^ix$|^x$/i.test(word);
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
    if (this.observer) return;
    
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