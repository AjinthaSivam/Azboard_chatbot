const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const faiss = require('faiss-node');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLEAI_API_KEY = process.env.GOOGLEAI_API_KEY;

const genAI = new GoogleGenerativeAI(GOOGLEAI_API_KEY);
const model = genAI.getGenerativeModel({model:'gemini-1.5-flash'});

const dimension = 768;

const index = new faiss.IndexFlatL2(dimension);

const upload = multer({ dest: 'uploads/' });

async function getEmbeddings(text) {
    try {
      // Use Gemini to generate a summary or key points from the text
      const result = await model.generateContent(`Summarize the following text in 5 key points:\n\n${text}`);
      const summary = result.response.text();
  
      // Use the summary to create a simple embedding
      const words = summary.toLowerCase().split(/\W+/).filter(word => word.length > 0);
      const embedding = new Array(dimension).fill(0);
  
      for (let i = 0; i < words.length && i < dimension; i++) {
        embedding[i] = words[i].charCodeAt(0) / 255; // Normalize to [0, 1]
      }
  
      return embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      // Return a random embedding as fallback
      return new Array(dimension).fill(0).map(() => Math.random());
    }
  }

// Function to process a specific PDF file
async function processSpecificPDF(filePath) {
    try {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      const text = data.text;
  
      console.log(`PDF content length: ${text.length} characters`);
  
      // Split text into smaller chunks
      const chunks = [];
      const chunkSize = 1000; // Adjust this value as needed
      for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
      }
  
      console.log(`Number of chunks: ${chunks.length}`);
  
      // Store chunks and their embeddings
      const chunkStore = [];
  
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await getEmbeddings(chunk);
        index.add(embedding);
        chunkStore.push({ id: i, text: chunk });
        console.log(`Processed chunk ${i + 1}/${chunks.length}`);
      }
  
      // Save chunkStore to a file
      fs.writeFileSync('chunkStore.json', JSON.stringify(chunkStore));
  
      console.log(`Processed PDF: ${path.basename(filePath)}`);
      console.log(`Added ${chunks.length} chunks to the index.`);
      console.log(`Index now contains ${index.ntotal()} vectors`);
    } catch (error) {
      console.error('Error processing PDF:', error);
    }
  }
  
  // Process the specific PDF on startup
  const pdfPath = path.join(__dirname, 'uploads/knowledge.pdf'); // Replace with your PDF file name
  console.log(`PDF path: ${pdfPath}`);
  console.log(`PDF exists: ${fs.existsSync(pdfPath)}`);
  processSpecificPDF(pdfPath);

  // Chat endpoint
app.post('/chat', async (req, res) => {
    const { message } = req.body;
    
    // Get embedding for the user's message
    const queryEmbedding = await getEmbeddings(message);
    
    // Get the total number of vectors in the index
    const ntotal = index.ntotal();
    
    console.log(`Total vectors in index: ${ntotal}`);
    
    // Set k to be the minimum of 5 and the total number of vectors
    const k = Math.min(5, ntotal);
    
    console.log(`Searching for ${k} nearest neighbors`);
    
    if (k === 0) {
      // No vectors in the index yet
      res.json({ response: "I'm sorry, but I don't have any information to work with yet. Please make sure a PDF has been processed." });
      return;
    }
    
    // Search for similar documents
    const searchResult = index.search(queryEmbedding, k);
    const distances = searchResult.distances || [];
    
    console.log(`Search results - distances: ${JSON.stringify(distances)}`);
    
    // Load chunkStore
    const chunkStore = JSON.parse(fs.readFileSync('chunkStore.json', 'utf8'));
    
    console.log(`Loaded chunkStore with ${chunkStore.length} items`);
    
    // Manually find the nearest neighbors based on distances
    const neighbors = distances.map((_, index) => index).sort((a, b) => distances[a] - distances[b]).slice(0, k);
    
    console.log(`Nearest neighbors: ${JSON.stringify(neighbors)}`);
    
    // Retrieve the actual documents
    const relevantDocs = neighbors.map(id => chunkStore[id].text);
    
    console.log(`Retrieved ${relevantDocs.length} relevant documents`);
    
    // Generate response using Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Context: ${relevantDocs.join('\n\n')}
    User: ${message}

AI: You are a friendly AI assistant for a property management service provider. Respond to the user's query based on the context provided. Don't provide package information unless specifically asked. Keep your response concise and use the following formatting:

- Use bullet points for lists
- Use numbers for sequential steps
- Use new lines to separate ideas
- Use **bold** for emphasis
- Keep the overall response under 100 words

If the user's query isn't related to property management or the information isn't in the context, politely redirect them to property management topics. Format your response using Markdown.`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    // Function to clean up and format the response
    function formatResponse(text) {
        return text
            .replace(/^AI: /, '') // Remove the "AI:" prefix if present
            .trim() // Remove leading/trailing whitespace
            .replace(/\n{3,}/g, '\n\n') // Replace multiple newlines with double newlines
            .replace(/\*\*/g, '**'); // Ensure proper bold formatting
    }
    
    res.json({response: formatResponse(response) });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});


