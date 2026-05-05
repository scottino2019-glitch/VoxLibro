import * as pdfjsLib from 'pdfjs-dist';

// Try multiple CDNs for the worker
const getWorkerSrc = () => {
  const version = pdfjsLib.version || '5.7.284';
  // Attempt with unpkg mjs first
  return `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`;
};

pdfjsLib.GlobalWorkerOptions.workerSrc = getWorkerSrc();

export async function extractTextFromPdf(file: File): Promise<string[]> {
  console.log('Starting PDF extraction for:', file.name, 'Size:', file.size);
  
  try {
    const arrayBuffer = await file.arrayBuffer();
    
    // Check for small files or potential empty buffers
    if (arrayBuffer.byteLength === 0) {
      throw new Error('Il file PDF sembra essere vuoto.');
    }

    const loadingTask = pdfjsLib.getDocument({ 
      data: arrayBuffer,
      useSystemFonts: true,
      stopAtErrors: false
    });

    console.log('PDF loading task initiated...');
    const pdf = await loadingTask.promise;
    console.log('PDF structure loaded. Total pages:', pdf.numPages);
    
    const fullText: string[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      try {
        const page = await pdf.getPage(i);
        // Use a higher scale for better text extraction if needed, but default is fine for textContent
        const textContent = await page.getTextContent();
        
        // Better joining of text items, considering line breaks
        let lastY;
        let pageLines: string[] = [];
        let currentLine = "";

        for (const item of textContent.items as any[]) {
          if (lastY !== undefined && Math.abs(item.transform[5] - lastY) > 5) {
            pageLines.push(currentLine.trim());
            currentLine = "";
          }
          currentLine += item.str + " ";
          lastY = item.transform[5];
        }
        pageLines.push(currentLine.trim());

        const cleanedPageText = pageLines.filter(line => line.length > 0).join('\n');
        
        if (cleanedPageText.trim()) {
          // Split into paragraphs to make it better for the reader
          const paragraphs = cleanedPageText.split(/\n\s*\n/);
          fullText.push(...paragraphs.filter(p => p.trim().length > 0));
        }
        
        console.log(`Successfully extracted text from page ${i}`);
      } catch (pageErr) {
        console.warn(`Could not extract text from page ${i}:`, pageErr);
      }
    }

    if (fullText.length === 0) {
      console.warn('Extraction finished but no text was found. This PDF might be an image/scan.');
    }

    return fullText;
  } catch (error) {
    console.error('Fatal error during PDF extraction:', error);
    throw error;
  }
}

export async function renderPageToImage(file: File, pageNum: number): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNum);
  
  const originalViewport = page.getViewport({ scale: 1.0 });
  const maxDimension = 1024;
  const scale = Math.min(maxDimension / originalViewport.width, maxDimension / originalViewport.height, 2.0);
  
  const viewport = page.getViewport({ scale }); 
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  
  if (!context) throw new Error('Could not create canvas context');
  
  canvas.height = viewport.height;
  canvas.width = viewport.width;
  
  // @ts-ignore - PDF.js types can be inconsistent across versions
  await page.render({
    canvasContext: context,
    viewport: viewport
  }).promise;
  
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

export async function getNumPages(file: File): Promise<number> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  return pdf.numPages;
}
