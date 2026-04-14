import express from 'express';
import { portfolio } from './routes/portfolio';
import { logRequest } from './log';
import { intent_route } from './routes/intent_route';
import './serializeBigInts';
import { intent_store } from './routes/intent_store';
import { intent_status } from './routes/intent_status';
import { intent_split } from './routes/intent_split';
import { chains } from './routes/chains';
import { initContexts } from './chains';

const app = express();
const port = process.env.PORT || 3000;


app.use(express.json())

app.get('/accounts/:userAddress/portfolio', portfolio)
app.post('/intents/route', intent_route)
app.post('/intents/split', intent_split)
app.post('/intent-operations', intent_store)
app.get('/intent-operation/:id', intent_status)
app.get('/chains', chains)

app.all(/.*/, (req, res) => {
    console.log("**** Unmapped request ****")

    logRequest(req)

    res.status(503).send({
        'error': 'Not implemented!'
    })
});



(async () => {
    await initContexts()
    app.listen(port, () => {
        console.log(`🚀 Server running on http://localhost:${port}`);
    });
})();