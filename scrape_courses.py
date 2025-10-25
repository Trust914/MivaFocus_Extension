"""
MIVA Open University Course Scraper
Automatically scrapes and updates course data from miva.edu.ng
Production-ready version for MivaFocus Extension
"""

import requests
from bs4 import BeautifulSoup
import json
import re
from datetime import datetime
from typing import Dict, List, Optional
import time
import logging
import sys
from pathlib import Path

# Configure logging with UTF-8 encoding for Windows compatibility
file_handler = logging.FileHandler('scraper.log', encoding='utf-8')
stream_handler = logging.StreamHandler(sys.stdout)

# Set UTF-8 encoding for console output on Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[file_handler, stream_handler]
)
logger = logging.getLogger(__name__)


class MivaCourseScraper:
    """Scraper for MIVA Open University course data"""
    
    DEPARTMENT_CODES = {
        'computer science': 'CSC',
        'cybersecurity': 'CYB',
        'data science': 'DTS',
        'information technology': 'IFT',
        'software engineering': 'SEN',
        'business management': 'BUA',
        'economics': 'ECO',
        'accounting': 'ACC',
        'public policy and administration': 'PPA',
        'entrepreneurship': 'ENT',
        'criminology and security studies': 'CRS',
        'mass communication': 'MAC',
        'communication and media studies': 'MAC',
        'nursing science': 'NUR',
        'public health': 'PHH',
    }
    
    def __init__(self, base_url: str = "https://miva.edu.ng", timeout: int = 15):
        self.base_url = base_url
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        })
        
        self.courses_data = {
            "metadata": {
                "version": "2.0.0",
                "lastUpdated": datetime.now().isoformat(),
                "academicYear": "2024/2025",
                "source": base_url,
                "scraper": "MivaFocus Course Scraper"
            },
            "faculties": {}
        }
    
    def scrape_faculties_page(self, faculties_url: str) -> List[Dict]:
        """Scrape main faculties page to extract all faculties and departments"""
        logger.info(f"Scraping faculties from: {faculties_url}")
        
        try:
            response = self.session.get(faculties_url, timeout=self.timeout)
            response.raise_for_status()
            soup = BeautifulSoup(response.content, 'html.parser')
            
            faculties = []
            faculty_sections = soup.find_all('div', class_=re.compile('faculties-child'))
            
            for section in faculty_sections:
                heading = section.find(['h2'], class_='elementor-heading-title')
                if heading and 'school' in heading.text.lower():
                    faculty_name = heading.text.strip()
                    logger.info(f"Found faculty: {faculty_name}")
                    
                    container = section.find_parent('div', class_=re.compile(r'elementor-element'))
                    if container:
                        dept_list = container.find_next('ul', class_='elementor-icon-list-items')
                        
                        if dept_list:
                            departments = []
                            for dept_item in dept_list.find_all('li', class_='elementor-icon-list-item'):
                                link = dept_item.find('a')
                                if link:
                                    dept_text = dept_item.get_text(strip=True)
                                    dept_url = link.get('href', '')
                                    dept_code = self._extract_dept_code(dept_text, dept_url)
                                    
                                    departments.append({
                                        'name': dept_text,
                                        'code': dept_code,
                                        'url': dept_url
                                    })
                            
                            faculties.append({
                                'name': faculty_name,
                                'departments': departments
                            })
            
            logger.info(f"Successfully scraped {len(faculties)} faculties")
            return faculties
            
        except requests.RequestException as e:
            logger.error(f"Network error scraping faculties: {e}")
            return []
        except Exception as e:
            logger.error(f"Unexpected error scraping faculties: {e}", exc_info=True)
            return []
    
    def _extract_dept_code(self, dept_name: str, url: str = "") -> str:
        """Extract standardized department code from name or URL"""
        dept_lower = dept_name.lower()
        
        # Try exact matches first
        for key, code in self.DEPARTMENT_CODES.items():
            if key in dept_lower:
                return code
        
        # Try URL matching
        if url:
            url_lower = url.lower()
            for key, code in self.DEPARTMENT_CODES.items():
                if key.replace(' ', '-') in url_lower:
                    return code
        
        # Generate acronym from capital letters
        words = re.findall(r'\b[A-Z][a-z]*', dept_name)
        if words:
            return ''.join(word[0] for word in words[:3]).upper()
        
        logger.warning(f"Could not determine code for department: {dept_name}")
        return "UNK"
    
    def scrape_department_page(self, dept_url: str, dept_name: str) -> Dict:
        """Scrape individual department page for course data"""
        logger.info(f"Scraping {dept_name}")
        
        try:
            response = self.session.get(dept_url, timeout=self.timeout)
            response.raise_for_status()
            soup = BeautifulSoup(response.content, 'html.parser')
            
            courses_by_level = {}
            accordion_items = soup.find_all('div', class_=re.compile(r'elementor-accordion-item'))
            
            for accordion in accordion_items:
                title_elem = accordion.find('a', class_='elementor-accordion-title')
                if not title_elem:
                    title_elem = accordion.find('span', class_='elementor-accordion-title')
                
                if title_elem:
                    title_text = title_elem.get_text(strip=True)
                    level_match = re.search(r'\b([12345])00\s*level\b', title_text, re.IGNORECASE)
                    
                    if level_match:
                        level = f"{level_match.group(1)}00"
                        content_div = accordion.find('div', class_=re.compile(r'elementor-tab-content'))
                        
                        if content_div:
                            courses_by_semester = self._extract_courses_from_tables(content_div)
                            
                            if courses_by_semester:
                                courses_by_level[level] = courses_by_semester
                                total = sum(len(courses) for courses in courses_by_semester.values())
                                logger.info(f"  Level {level}: {total} courses")
            
            return courses_by_level
            
        except requests.RequestException as e:
            logger.error(f"Network error scraping {dept_name}: {e}")
            return {}
        except Exception as e:
            logger.error(f"Error scraping {dept_name}: {e}", exc_info=True)
            return {}
    
    def _extract_courses_from_tables(self, content_div) -> Dict:
        """Extract courses organized by semester from content div"""
        courses_by_semester = {}
        tables = content_div.find_all('table', class_='curriculum-table')
        
        if not tables:
            tables = content_div.find_all('table')
        
        for idx, table in enumerate(tables):
            semester = self._detect_table_semester(table, idx)
            
            if semester:
                courses = self._parse_table_courses(table)
                
                if semester not in courses_by_semester:
                    courses_by_semester[semester] = []
                
                courses_by_semester[semester].extend(courses)
        
        return courses_by_semester
    
    def _detect_table_semester(self, table, table_index: int) -> Optional[str]:
        """Detect which semester a table belongs to"""
        
        # Check HTML comments before table
        for sibling in table.previous_siblings:
            if hasattr(sibling, 'string') and sibling.string:
                comment_text = sibling.string.strip().lower()
                if '1st semester' in comment_text or 'first semester' in comment_text:
                    return 'first'
                elif '2nd semester' in comment_text or 'second semester' in comment_text:
                    return 'second'
                elif 'rain semester' in comment_text:
                    return 'rain'
        
        # Check table header
        thead = table.find('thead')
        if thead:
            for th in thead.find_all('th'):
                th_text = th.get_text(strip=True).lower()
                if '1st semester' in th_text or 'first semester' in th_text:
                    return 'first'
                elif '2nd semester' in th_text or 'second semester' in th_text:
                    return 'second'
                elif 'rain semester' in th_text:
                    return 'rain'
        
        # Check first row
        first_row = table.find('tr')
        if first_row:
            row_text = first_row.get_text(strip=True).lower()
            if '1st semester' in row_text or 'first semester' in row_text:
                return 'first'
            elif '2nd semester' in row_text or 'second semester' in row_text:
                return 'second'
            elif 'rain semester' in row_text:
                return 'rain'
        
        # Fallback to table position
        return 'first' if table_index == 0 else 'second' if table_index == 1 else None
    
    def _parse_table_courses(self, table) -> List[Dict]:
        """Parse course information from table rows"""
        courses = []
        tbody = table.find('tbody') or table
        
        # Try finding rows with accordion-header class (most common)
        accordion_rows = tbody.find_all('tr', class_='accordion-header')
        
        # Fallback: find all rows with 2 td cells
        if not accordion_rows:
            accordion_rows = []
            for row in tbody.find_all('tr'):
                cells = row.find_all('td')
                
                if len(cells) == 2:
                    first_text = cells[0].get_text(strip=True)
                    second_text = cells[1].get_text(strip=True)
                    
                    # Valid course row: substantial title + numeric units
                    if first_text and len(first_text) > 3 and re.search(r'\d+', second_text):
                        accordion_rows.append(row)
        
        # Extract course data
        for row in accordion_rows:
            cells = row.find_all('td')
            
            if len(cells) >= 2:
                title = cells[0].get_text(strip=True)
                units_text = cells[1].get_text(strip=True)
                
                units_match = re.search(r'(\d+)', units_text)
                if units_match and title:
                    courses.append({
                        'title': title,
                        'creditUnits': int(units_match.group(1))
                    })
        
        return courses
    
    def scrape_all(self, faculties_url: str) -> Dict:
        """Main scraping method - scrapes all faculties and departments"""
        logger.info("=" * 70)
        logger.info("MIVA OPEN UNIVERSITY COURSE SCRAPER - STARTING")
        logger.info("=" * 70)
        
        faculties = self.scrape_faculties_page(faculties_url)
        
        if not faculties:
            logger.error("No faculties found. Scraping failed.")
            return self.courses_data
        
        total_departments = 0
        total_courses = 0
        
        for faculty in faculties:
            faculty_name = faculty['name']
            logger.info(f"\n{faculty_name}")
            logger.info("-" * 70)
            
            self.courses_data['faculties'][faculty_name] = {'departments': {}}
            
            for dept in faculty['departments']:
                dept_name = dept['name']
                dept_code = dept['code']
                dept_url = dept['url']
                
                if dept_url.startswith('/'):
                    dept_url = self.base_url + dept_url
                
                courses = self.scrape_department_page(dept_url, dept_name)
                
                if courses:
                    self.courses_data['faculties'][faculty_name]['departments'][dept_code] = {
                        'name': dept_name,
                        'url': dept_url,
                        'courses': courses
                    }
                    
                    dept_total = sum(
                        len(semester_courses)
                        for level_data in courses.values()
                        for semester_courses in level_data.values()
                    )
                    total_departments += 1
                    total_courses += dept_total
                    logger.info(f"[OK] {dept_code}: {dept_total} courses")
                else:
                    logger.warning(f"[SKIP] {dept_code}: No courses found")
                
                time.sleep(1)  # Rate limiting
        
        logger.info("\n" + "=" * 70)
        logger.info(f"SCRAPING COMPLETED SUCCESSFULLY")
        logger.info(f"Total Departments: {total_departments}")
        logger.info(f"Total Courses: {total_courses}")
        logger.info("=" * 70)
        
        return self.courses_data
    
    def save_to_json(self, filename: str = 'miva_courses_full.json'):
        """Save complete scraped data to JSON"""
        try:
            output_path = Path(filename)
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(self.courses_data, f, indent=2, ensure_ascii=False)
            logger.info(f"Full data saved to: {output_path.absolute()}")
        except Exception as e:
            logger.error(f"Error saving full data: {e}")
    
    def save_extension_format(self, filename: str = 'courses_database.json'):
        """Save in optimized format for browser extension"""
        try:
            flattened = {
                "metadata": self.courses_data['metadata'],
                "departments": {}
            }
            
            for faculty_data in self.courses_data['faculties'].values():
                for dept_code, dept_data in faculty_data['departments'].items():
                    flattened['departments'][dept_code] = {
                        'name': dept_data['name'],
                        'courses': dept_data['courses']
                    }
            
            output_path = Path(filename)
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(flattened, f, indent=2, ensure_ascii=False)
            
            logger.info(f"Extension format saved to: {output_path.absolute()}")
            
        except Exception as e:
            logger.error(f"Error saving extension format: {e}")


def main():
    """Main execution function"""
    try:
        scraper = MivaCourseScraper(base_url="https://miva.edu.ng")
        
        # Scrape all courses
        scraper.scrape_all("https://miva.edu.ng")
        
        # Save both formats
        scraper.save_to_json('miva_courses_full.json')
        scraper.save_extension_format('courses_database.json')
        
        logger.info("\n[SUCCESS] Scraping completed successfully!")
        return 0
        
    except KeyboardInterrupt:
        logger.warning("\nScraping interrupted by user")
        return 1
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())