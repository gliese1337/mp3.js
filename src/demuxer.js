//import "id3.js"

MP3Demuxer = Demuxer.extend(function() {
    Demuxer.register(this);
    
    this.probe = function(stream) {
        var header = this.getID3v2Header(stream);
        // TODO: check first mp3 frame
        return !!header;
    };
    
    this.getID3v2Header = function(stream) {
        if (stream.peekString(0, 3) == 'ID3') {
            stream = Stream.fromBuffer(stream.peekBuffer(0, 10));
            stream.advance(3); // 'ID3'

            var major = stream.readUInt8();
            var minor = stream.readUInt8();
            var flags = stream.readUInt8();
            var bytes = stream.readBuffer(4).data;
            var length = (bytes[0] << 21) | (bytes[1] << 14) | (bytes[2] << 7) | bytes[3];

            return { 
                version: '2.' + major + '.' + minor, 
                major: major, 
                minor: minor, 
                flags: flags, 
                length: length 
            };
        }
        
        return null;
    };
    
    const XING_OFFSETS = [[32, 17], [17, 9]];
    this.prototype.parseDuration = function(header) {
        var stream = this.stream;
        var frames;
                
        var offset = stream.offset;
        if (!header || header.layer !== 3)
            return false;
        
        // Check for Xing/Info tag
        stream.advance(XING_OFFSETS[(header.flags & FLAGS.LSF_EXT)][header.nchannels() === 1 ? 1 : 0]);
        var tag = stream.readString(4);
        if (tag === 'Xing' || tag === 'Info') {
            var flags = stream.readUInt32();
            if (flags & 0x1) 
                frames = stream.readUInt32();
        }
        
        // Check for VBRI tag (always 32 bytes after end of mpegaudio header)
        stream.advance(offset + 4 + 32 - stream.offset);
        tag = stream.readString(4);
        if (tag == 'VBRI' && stream.readUInt16() === 1) { // Check tag version
            stream.advance(4); // skip delay and quality
            stream.advance(4); // skip size
            frames = stream.readUInt32();
        }
        
        if (!frames)
            return false;
            
        var samplesPerFrame = (header.flags & FLAGS.LSF_EXT) ? 576 : 1152;
        this.emit('duration', (frames * samplesPerFrame) / header.samplerate * 1000 | 0);
            
        return true;
    };
    
    this.prototype.readChunk = function() {
        var stream = this.stream;
        
        if (!this.sentInfo) {
            // read id3 metadata if it exists
            var id3header = MP3Demuxer.getID3v2Header(stream);
            if (id3header) {
                stream.advance(10);
                
                if (id3header.major > 2) {
                    var id3 = new ID3v23Stream(id3header, stream);
                } else {
                    var id3 = new ID3v22Stream(id3header, stream);
                }
                
                this.emit('metadata', id3.read());
            }
            
            // read the header of the first audio frame
            var off = stream.offset;
            var s = new MP3Stream(new Bitstream(stream));
            
            var header = MP3FrameHeader.decode(s);
            if (!header)
                return this.emit('error', 'Could not find first frame.');
            
            this.emit('format', {
                formatID: 'mp3',
                sampleRate: header.samplerate,
                channelsPerFrame: header.nchannels(),
                bitrate: header.bitrate
            });
            
            this.parseDuration(header);
            stream.advance(off - stream.offset);
            
            this.sentInfo = true;
        }
        
        while (stream.available(1)) {
            var buffer = stream.readSingleBuffer(stream.remainingBytes());
            this.emit('data', buffer, stream.remainingBytes() === 0);
        }
    };
});